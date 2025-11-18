import re
import feedparser
import html
import datetime
import os
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlencode, quote
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import joinedload
from sqlalchemy.sql import func
from flask_migrate import Migrate # <-- ADD THIS IMPORT


## --- App Setup ---
basedir = os.path.abspath(os.path.dirname(__file__))
# Use DATA_DIR env var for persistent storage, default to app directory
data_dir = os.environ.get('DATA_DIR', basedir)
db_path = os.path.join(data_dir, "app.db")

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)
migrate = Migrate(app, db) # <-- ADD THIS LINE

## --- Database Models ---

# Association table for Custom Streams and Feeds
custom_stream_feeds = db.Table('custom_stream_feeds',
    db.Column('custom_stream_id', db.Integer, db.ForeignKey('custom_stream.id'), primary_key=True),
    db.Column('feed_id', db.Integer, db.ForeignKey('feed.id'), primary_key=True)
)

class Category(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False, unique=True)
    feeds = db.relationship('Feed', backref='category', lazy='dynamic')

class Feed(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    url = db.Column(db.String(500), unique=True, nullable=False)
    articles = db.relationship('Article', backref='feed', lazy=True, cascade="all, delete-orphan")
    deleted_at = db.Column(db.DateTime(timezone=False), nullable=True)
    category_id = db.Column(db.Integer, db.ForeignKey('category.id'), nullable=False)
    
    # *** NEW: Column for 'All Feeds' exclusion ***
    exclude_from_all = db.Column(db.Boolean, default=False, nullable=False)
    
    # *** NEW: Caching columns for ETag and Last-Modified ***
    etag = db.Column(db.String(200), nullable=True)
    last_modified = db.Column(db.String(200), nullable=True)
    
    # Use back_populates to explicitly define the many-to-many relationship
    custom_streams = db.relationship('CustomStream', secondary=custom_stream_feeds, lazy='dynamic',
                                     back_populates='feeds')

class Article(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(300), nullable=False)
    link = db.Column(db.String(500), unique=True, nullable=False)
    summary = db.Column(db.Text)
    full_content = db.Column(db.Text)
    image_url = db.Column(db.String(1000))
    author = db.Column(db.String(200))
    published = db.Column(db.DateTime(timezone=False))
    is_favorite = db.Column(db.Boolean, default=False)
    is_read_later = db.Column(db.Boolean, default=False)
    feed_id = db.Column(db.Integer, db.ForeignKey('feed.id'), nullable=False)

class CustomStream(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False, unique=True)
    
    # Use back_populates to complete the many-to-many relationship
    feeds = db.relationship('Feed', secondary=custom_stream_feeds, lazy='dynamic',
                        back_populates='custom_streams')
                        
    deleted_at = db.Column(db.DateTime(timezone=False), nullable=True)


## --- Helper Functions ---

def clean_text(text, strip_html_tags=True):
    """Unescapes HTML, removes common feed artifacts, and optionally strips tags."""
    if not text:
        return ""
    text = html.unescape(text)
    text = text.replace('[…]', '').replace('&hellip;', '').replace('...', '').strip()
    if strip_html_tags:
        text = re.sub('<[^<]+?>', '', text)
    return text

def smart_truncate(content, length=300, suffix='...'):
    """Truncates a string to a length, respecting word boundaries."""
    if len(content) <= length:
        return content
    last_space = content.rfind(' ', 0, length)
    if last_space == -1: # No spaces, hard cut
        return content[:length] + suffix
    return content[:last_space] + suffix

def find_image_url(entry):
    """Attempts to find the best-quality image URL from a feed entry."""
    if 'media_content' in entry and entry.media_content:
        for media in entry.media_content:
            if media.get('medium') == 'image' and 'url' in media:
                return media['url']
    if 'enclosures' in entry and entry.enclosures:
        for enclosure in entry.enclosures:
            if 'image' in enclosure.get('type', '') and 'href' in enclosure:
                return enclosure['href']
    if 'media_thumbnail' in entry and entry.media_thumbnail:
        if isinstance(entry.media_thumbnail, list) and len(entry.media_thumbnail) > 0:
            return entry.media_thumbnail[0].get('url')
    
    html_content = next((item['value'] for item in entry.get('content', []) if 'value' in item), None)
    if not html_content:
        html_content = entry.get('summary', '')
        
    if html_content:
        match = re.search(r'<img [^>]*src="([^"]+)"', html_content)
        if match:
            return match.group(1)
    return None

def _update_articles_for_feed(feed_instance, feed_data):
    """Parses feed data and adds new articles to the database for a given feed."""
    added_count = 0
    for entry in feed_data.entries:
        if Article.query.filter_by(link=entry.link).first():
            continue

        published_time = datetime.datetime.now()
        if 'published_parsed' in entry and entry.published_parsed:
            try:
                published_time = datetime.datetime(*entry.published_parsed[:6])
            except ValueError:
                pass 

        content_html = next((item['value'] for item in entry.get('content', []) if 'value' in item),
                            entry.get('summary', ''))
        
        summary_text = clean_text(entry.get('summary', ''), strip_html_tags=True)
        if not summary_text and content_html:
            summary_text = clean_text(content_html, strip_html_tags=True)
        
        smart_summary = smart_truncate(summary_text, length=300)
        
        image_url_found = find_image_url(entry)
        
        # --- NEW: Pinterest Hi-Res Fix ---
        if image_url_found and 'i.pinimg.com' in image_url_found:
            # Try to replace thumbnail size with 'originals' for best quality
            # e.g., /236x/ -> /originals/
            # e.g., /564x/ -> /originals/
            hi_res_url = re.sub(r'\/(\d+x|236x)\/', '/originals/', image_url_found)
            if hi_res_url != image_url_found:
                print(f"Upgraded Pinterest image URL to: {hi_res_url}")
                image_url_found = hi_res_url
            else:
                # Try replacing with 736x as another common high-res
                hi_res_url = re.sub(r'\/(\d+x|236x)\/', '/736x/', image_url_found)
                if hi_res_url != image_url_found:
                    print(f"Upgraded Pinterest image URL to: {hi_res_url}")
                    image_url_found = hi_res_url
        # --- END: Pinterest Hi-Res Fix ---
        
        new_article = Article(
            title=clean_text(entry.get('title', 'Untitled Article'), strip_html_tags=True),
            link=entry.link,
            summary=smart_summary,
            full_content=clean_text(content_html, strip_html_tags=False),
            image_url=image_url_found, # Use the (potentially) upgraded URL
            author=clean_text(entry.get('author', 'Unknown Author'), strip_html_tags=True),
            published=published_time,
            feed_id=feed_instance.id
        )
        db.session.add(new_article)
        added_count += 1
        
    if added_count > 0:
        db.session.commit()
    return added_count

def get_category_data(category):
    """Serializes a Category object to a dictionary."""
    return {
        'id': category.id,
        'name': category.name
        # No exclude_from_all here, it's handled at the feed level
    }

def get_rss_bridge_feed(base_url, target_url):
    """
    Asks the RSS-Bridge service to find a bridge for the target URL
    and returns a parsable feed URL if successful.
    """
    try:
        # 1. Ask RSS-Bridge to find a bridge for the URL
        # We quote the target_url to make it safe for a query string
        find_url = f"{base_url}/?action=findbridge&url={quote(target_url)}"
        response = requests.get(find_url, timeout=10) # 10s timeout
        response.raise_for_status()
        
        data = response.json()
        bridge_name = data.get('bridge')
        params = data.get('parameters', {})

        if not bridge_name:
            print(f"RSS-Bridge: No bridge found for {target_url}")
            return None

        # 2. Build the final feed URL using the bridge it found
        query_params = {
            'action': 'display',
            'bridge': bridge_name,
            'format': 'Atom',
            **params
        }
        
        query_string = urlencode(query_params)
        final_bridge_url = f"{base_url}/?{query_string}"
        
        print(f"RSS-Bridge: Generated feed URL: {final_bridge_url}")
        return final_bridge_url

    except requests.exceptions.RequestException as e:
        print(f"Error contacting RSS-Bridge: {e}")
        return None
    except Exception as e:
        print(f"Error parsing RSS-Bridge response: {e}")
        return None

# --- REMOVED Dribbble Scraper ---


## --- Initialization Function ---
def initialize_database():
    """Creates all database tables and ensures the 'Uncategorized' category exists."""
    with app.app_context():
        print("Initializing database...")
        db.create_all()
        
        uncategorized = Category.query.filter_by(name='Uncategorized').first()
        if not uncategorized:
            uncategorized = Category(name='Uncategorized')
            db.session.add(uncategorized)
            db.session.commit()
            print("Created 'Uncategorized' category.")
        print("Database initialization complete.")

## --- Main Routes ---

@app.route('/')
def home():
    """Serves the main index.html template."""
    return render_template('index.html')

## --- API: Get All Data ---

@app.route('/api/data')
def get_data():
    """Returns all categories, feeds, and streams as a single JSON object."""
    categories = Category.query.order_by(Category.name).all()
    structured_categories = [get_category_data(cat) for cat in categories]
    
    active_feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    removed_feeds = Feed.query.filter(Feed.deleted_at.isnot(None)).order_by(Feed.deleted_at.desc()).all()
    
    active_streams = CustomStream.query.filter(CustomStream.deleted_at.is_(None)).order_by(CustomStream.name).all()
    removed_streams = CustomStream.query.filter(CustomStream.deleted_at.isnot(None)).order_by(CustomStream.deleted_at.desc()).all()
    
    stream_feed_links = db.session.query(custom_stream_feeds).all()

    return jsonify({
        'categories': structured_categories,
        # *** UPDATED: Return exclusion status for feeds ***
        'feeds': [{'id': f.id, 'title': f.title, 'category_id': f.category_id, 'exclude_from_all': f.exclude_from_all} for f in active_feeds],
        'removedFeeds': [{'id': f.id, 'title': f.title, 'deleted_at': f.deleted_at.isoformat()} for f in removed_feeds],
        'customStreams': [{'id': cs.id, 'name': cs.name} for cs in active_streams],
        'removedStreams': [{'id': cs.id, 'name': cs.name, 'deleted_at': cs.deleted_at.isoformat()} for cs in removed_streams],
        'customStreamFeedLinks': [{'custom_stream_id': link.custom_stream_id, 'feed_id': link.feed_id} for link in stream_feed_links],
    })

## --- API: Paginated Articles Endpoint (UPDATED) ---

@app.route('/api/articles')
def get_articles():
    """Gets a paginated list of articles based on view type."""
    page = request.args.get('page', 1, type=int)
    # *** CHANGE 1: Set default to 24 ***
    per_page = request.args.get('per_page', 24, type=int) # Load 24 articles at a time
    
    # Get view type and ID from query params
    view_type = request.args.get('view_type', 'all')
    view_id = request.args.get('view_id', type=int)
    author_name = request.args.get('author_name', type=str)

    # Base query
    query = Article.query.order_by(Article.published.desc())
    
    # Apply filters based on view_type
    if view_type == 'feed' and view_id:
        query = query.filter(Article.feed_id == view_id)
        
    elif view_type == 'category' and view_id:
        query = query.join(Feed).filter(Feed.category_id == view_id)
        
    elif view_type == 'custom_stream' and view_id:
        stream = CustomStream.query.get(view_id)
        if stream:
            feed_ids = [f.id for f in stream.feeds]
            if feed_ids:
                query = query.filter(Article.feed_id.in_(feed_ids))
            else:
                # No feeds in stream, return no articles
                query = query.filter(Article.id == -1) 
        
    elif view_type == 'favorites':
        query = query.filter(Article.is_favorite == True)
        
    elif view_type == 'readLater':
        query = query.filter(Article.is_read_later == True)
        
    elif view_type == 'author' and author_name:
        query = query.filter(Article.author == author_name)
    
    # *** NEW: For 'all' view, filter out excluded feeds ***
    elif view_type == 'all':
        query = query.join(Feed).filter(Feed.exclude_from_all == False)
    
    # 'all' (or any other case) doesn't need a special filter here,
    # but we MUST ensure we only show articles from *active* feeds.
    
    active_feed_ids_query = db.session.query(Feed.id).filter(Feed.deleted_at.is_(None))
    query = query.filter(Article.feed_id.in_(active_feed_ids_query))

    # Use Flask-SQLAlchemy's paginate() method
    pagination = query.paginate(page=page, per_page=per_page, error_out=False)
    articles = pagination.items

    return jsonify({
        'articles': [
            {
                'id': a.id, 'title': a.title, 'link': a.link, 'summary': a.summary,
                'full_content': a.full_content, 'image_url': a.image_url, 'author': a.author,
                'published': a.published.isoformat() if a.published else datetime.datetime.now().isoformat(),
                'is_favorite': a.is_favorite, 'is_read_later': a.is_read_later,
                'feed_title': a.feed.title if a.feed else 'Unknown Feed', 
                'feed_id': a.feed_id
            } for a in articles
        ],
        'total_pages': pagination.pages,
        'current_page': page,
        'has_next': pagination.has_next
    })


## --- API: Feed Management ---

@app.route('/api/add_feed', methods=['POST'])
def add_feed():
    """Adds a new feed from a URL, with auto-discovery."""
    data = request.get_json()
    url = data.get('url')
    category_id = data.get('category_id')

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    # Strip leading/trailing whitespace
    url = url.strip()

    # --- NEW: Reddit URL Fix ---
    try:
        # Use regex to find reddit URLs (http, https, www, or none)
        # It looks for 'reddit.com/r/subreddit' and captures the subreddit part
        reddit_match = re.match(r'(?:https?:\/\/)?(?:www\.)?reddit\.com\/r\/([a-zA-Z0-9_]+)\/?.*', url, re.IGNORECASE)
        if reddit_match:
            subreddit = reddit_match.group(1)
            # Rebuild it as an RSS feed URL
            url = f'https://www.reddit.com/r/{subreddit}/.rss'
            print(f"Converted Reddit URL to: {url}")
    except Exception as e:
        print(f"Error during Reddit URL conversion (non-critical): {e}")
        # If regex fails, just proceed with the original URL
        pass
    # --- END: Reddit URL Fix ---

    # --- NEW: Pinterest URL Fix ---
    try:
        # Check if it's a Pinterest URL but NOT already the feed URL
        if 'pinterest.com' in url and not url.endswith('/feed.rss'):
            # Regex to find Pinterest user URLs (http, https, www, or none)
            pinterest_match = re.match(r'(?:https?:\/\/)?(?:www\.)?pinterest\.com\/([a-zA-Z0-9_-]+)\/?.*', url, re.IGNORECASE)
            if pinterest_match:
                username = pinterest_match.group(1)
                # Rebuild it as an RSS feed URL
                url = f'https://www.pinterest.com/{username}/feed.rss'
                print(f"Converted Pinterest URL to: {url}")
    except Exception as e:
        print(f"Error during Pinterest URL conversion (non-critical): {e}")
        # If regex fails, just proceed with the original URL
        pass
    # --- END: Pinterest URL Fix ---

    # --- REMOVED Dribbble URL Fix ---

    # Ensure "Uncategorized" exists
    target_category = None
    if category_id:
        target_category = Category.query.get(category_id)
    if not target_category:
        target_category = Category.query.filter_by(name='Uncategorized').first()
        if not target_category:
            target_category = Category(name='Uncategorized')
            db.session.add(target_category)
            db.session.commit()

    try:
        feed_data = None
        feed_url = url  # This is the original URL the user gave

        headers = {
            'User-Agent': 'VolumeRead21-Feed-Finder/1.0'
        }

        # --- Step 1: Parse the URL directly ---
        if not feed_url.startswith(('http://', 'https://')):
            feed_url_with_scheme = 'https://' + feed_url
        else:
            feed_url_with_scheme = feed_url

        parsed_data = feedparser.parse(feed_url_with_scheme, request_headers=headers)
        if parsed_data.feed and (parsed_data.entries or parsed_data.feed.get('title')):
            feed_data = parsed_data
            feed_url = feed_url_with_scheme  # We're adding the direct feed
            print(f"Successfully parsed direct URL: {feed_url}")
        else:
            print(f"Direct parse failed for {feed_url_with_scheme}.")

            # --- STEP 1.5: Try common feed suffixes ---
            common_suffixes = ['/feed', '/atom.xml', '/rss.xml', '/rss']
            base_url = feed_url_with_scheme.rstrip('/')
            
            for suffix in common_suffixes:
                feed_url_with_suffix = base_url + suffix
                print(f"Attempting common suffix: {feed_url_with_suffix}")
                parsed_data = feedparser.parse(feed_url_with_suffix, request_headers=headers)
                
                if parsed_data.feed and (parsed_data.entries or parsed_data.feed.get('title')):
                    feed_data = parsed_data
                    feed_url = feed_url_with_suffix  # We found it!
                    print(f"Successfully parsed {feed_url}")
                    break  # Exit the loop
            
            # --- Step 2: Discover feed from HTML (if 1 and 1.5 failed) ---
            if not feed_data:
                print("Common suffixes failed. Attempting discovery...")
                
                discovery_url = feed_url_with_scheme  # Use the original URL for discovery
                try:
                    response = requests.get(discovery_url, headers=headers, timeout=5)
                    response.raise_for_status()

                    content_type = response.headers.get('Content-Type', '').lower()
                    if 'xml' in content_type or 'rss' in content_type:
                        print("URL redirected to a feed, parsing that.")
                        feed_data = feedparser.parse(response.content, request_headers=headers)
                        feed_url = response.url  # This is the new, redirected feed URL
                    else:
                        soup = BeautifulSoup(response.text, 'html.parser')
                        link_tag = soup.find('link', {'rel': 'alternate', 'type': re.compile(r'application/(rss|atom)\+xml')})

                        if link_tag and link_tag.get('href'):
                            discovered_url = urljoin(response.url, link_tag['href'])
                            print(f"Discovered feed URL from HTML: {discovered_url}")

                            feed_data = feedparser.parse(discovered_url, request_headers=headers)
                            feed_url = discovered_url  # This is the discovered feed URL

                except requests.exceptions.RequestException as e:
                    print(f"Error during feed discovery: {e}")
                    pass  # Fail gracefully and let Step 3 take over

        # --- Step 3: Try RSS-Bridge as a last resort ---
        if not feed_data:
            print("Discovery failed. Attempting RSS-Bridge...")
            rss_bridge_base_url = os.environ.get('RSS_BRIDGE_URL')

            if rss_bridge_base_url:
                # Use the URL *with* scheme for RSS-Bridge
                bridge_feed_url = get_rss_bridge_feed(rss_bridge_base_url, feed_url_with_scheme)

                if bridge_feed_url:
                    # Parse this NEWLY generated feed URL
                    feed_data = feedparser.parse(bridge_feed_url, request_headers=headers)
                    feed_url = bridge_feed_url  # This is CRITICAL
                else:
                    print("RSS-Bridge could not generate a feed.")
            else:
                print("RSS_BRIDGE_URL not set, skipping step 3.")

        # --- Final check: Did we find *any* feed? ---
        if not feed_data or not feed_data.feed or (not feed_data.entries and not feed_data.feed.get('title')):
            return jsonify({'error': 'Could not find, discover, or generate a feed for this URL.'}), 400

        # Check if this *final* feed URL (direct, discovered, or generated) already exists
        if Feed.query.filter_by(url=feed_url).first():
            return jsonify({'error': 'Feed already exists (might be in Removed Feeds)'}), 400

        # --- Add the feed ---
        feed_title = clean_text(feed_data.feed.get('title', 'Untitled Feed'), strip_html_tags=True)
        new_feed = Feed(
            title=feed_title, 
            url=feed_url, 
            category_id=target_category.id,
            etag=feed_data.get('etag'), # *** NEW: Store etag on add ***
            last_modified=feed_data.get('modified') # *** NEW: Store modified on add ***
        )
        db.session.add(new_feed)
        db.session.commit()

        _update_articles_for_feed(new_feed, feed_data)
        return jsonify({'success': True, 'title': feed_title}), 201

    except Exception as e:
        db.session.rollback()
        print(f"Error adding feed: {e}")
        return jsonify({'error': 'An unexpected error occurred. Invalid URL or format?'}), 500

@app.route('/api/feed/<int:feed_id>', methods=['DELETE'])
def soft_delete_feed(feed_id):
    """Marks a feed as deleted."""
    feed = Feed.query.get_or_404(feed_id)
    if feed.deleted_at is not None:
        return jsonify({'message': 'Feed already marked for deletion'}), 200
    try:
        feed.deleted_at = datetime.datetime.now()
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error soft deleting feed: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/feed/<int:feed_id>/permanent', methods=['DELETE'])
def permanent_delete_feed(feed_id):
    """Permanently deletes a feed and all associated articles."""
    feed = Feed.query.get_or_404(feed_id)
    try:
        stmt = custom_stream_feeds.delete().where(custom_stream_feeds.c.feed_id == feed_id)
        db.session.execute(stmt)
        
        db.session.delete(feed)
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error permanently deleting feed: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/feed/<int:feed_id>/restore', methods=['POST'])
def restore_feed(feed_id):
    """Restores a soft-deleted feed to the 'Uncategorized' category."""
    feed = Feed.query.get_or_404(feed_id)
    if feed.deleted_at is None: 
        return jsonify({'message': 'Feed is not marked for deletion'}), 200
    
    uncategorized = Category.query.filter_by(name='Uncategorized').first()
    if not uncategorized:
        print("WARNING: 'Uncategorized' category missing, re-creating it.")
        uncategorized = Category(name='Uncategorized')
        db.session.add(uncategorized)
        db.session.commit()

    try: 
        feed.deleted_at = None
        feed.category_id = uncategorized.id 
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e: 
        db.session.rollback()
        print(f"Error restoring feed: {e}")
        return jsonify({'error': str(e)}), 500

## --- NEW: Helper for Parallel Refresh ---
def _fetch_one_feed(feed):
    """
    Helper function to fetch one feed in a thread.
    Uses ETag and Last-Modified headers for conditional GETs.
    Returns: (feed_object, feed_data, error_message, new_etag, new_modified)
    """
    try:
        headers = { 'User-Agent': 'VolumeRead21-Feed-Refresher/1.0' }
        
        # --- MODIFIED: Use etag and modified from the feed object ---
        feed_data = feedparser.parse(
            feed.url, 
            request_headers=headers, 
            etag=feed.etag, 
            modified=feed.last_modified
        )
        
        # --- NEW: Check for 304 Not Modified ---
        if feed_data.status == 304:
            print(f"Feed '{feed.title}' not modified (304).")
            # No new data, no error, but also no new etag/modified
            return (feed, None, None, None, None) 
            
        if feed_data.status >= 400 or feed_data.status == 301:
            error_msg = f"Error fetching {feed.title}: Status {feed_data.status}"
            return (feed, None, error_msg, None, None) 
            
        # --- NEW: Get new caching headers from the response ---
        new_etag = feed_data.get('etag')
        new_modified = feed_data.get('modified')
            
        return (feed, feed_data, None, new_etag, new_modified)
        
    except Exception as e:
        error_msg = f"Error processing {feed.title}: {e}"
        return (feed, None, error_msg, None, None)

## --- NEW: Parallel Refresh Function ---
@app.route('/api/refresh_all_feeds', methods=['POST'])
def refresh_all_feeds():
    """Refreshes all active feeds, fetching new articles IN PARALLEL."""
    feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    total_added = 0
    errors = []

    if not feeds:
        return jsonify({'success': True, 'message': 'No active feeds to refresh.', 'added_count': 0})
    
    # Use a ThreadPoolExecutor to fetch feeds in parallel
    # We set max_workers to 10 to fetch up to 10 feeds at a time
    with ThreadPoolExecutor(max_workers=10) as executor:
        # 'results' will be an iterator of (feed, feed_data, error, new_etag, new_modified) tuples
        results = executor.map(_fetch_one_feed, feeds)
    
    # Now process the results in the main thread (safer for DB)
    try:
        for feed, feed_data, error, new_etag, new_modified in results:
            if error:
                errors.append(error)
                print(error)
                continue
            
            # Get the feed object attached to the current session
            # This is safer than using the 'feed' object from the other thread
            feed_in_session = db.session.get(Feed, feed.id)
            if not feed_in_session:
                print(f"Skipping feed {feed.id} (not found in session).")
                continue

            # --- NEW: Update caching headers in the DB ---
            if new_etag:
                feed_in_session.etag = new_etag
            if new_modified:
                feed_in_session.last_modified = new_modified
            
            # feed_data will be None if status was 304 (Not Modified)
            if feed_data:
                try:
                    # _update_articles_for_feed commits after adding articles
                    count = _update_articles_for_feed(feed_in_session, feed_data)
                    total_added += count
                except Exception as e:
                    db_error = f"Error updating DB for {feed_in_session.title}: {e}"
                    errors.append(db_error)
                    print(db_error)
                    db.session.rollback() # Rollback this specific feed's transaction
        
        # Commit all ETag/Last-Modified changes (and any remaining article additions)
        db.session.commit()
            
    except Exception as e:
        db.session.rollback()
        print(f"Major error in refresh loop: {e}")
        return jsonify({'error': 'An internal error occurred during refresh.'}), 500
            
    if errors:
        return jsonify({
            'success': False if len(errors) == len(feeds) else True,
            'message': f'Refreshed feeds, added {total_added} new articles.',
            'errors': errors
        }), 200 if total_added > 0 else 500
        
    return jsonify({'success': True, 'added_count': total_added})

@app.route('/api/move_feed', methods=['POST'])
def move_feed():
    """Moves a feed to a new category."""
    data = request.get_json()
    feed_id = data.get('feed_id')
    new_category_id = data.get('new_category_id')

    if not feed_id or not new_category_id:
        return jsonify({'error': 'Missing data'}), 400
        
    feed = Feed.query.get_or_404(feed_id)
    Category.query.get_or_404(new_category_id) 
    
    try:
        feed.category_id = new_category_id
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route('/api/feed/<int:feed_id>', methods=['PUT'])
def update_feed_settings(feed_id):
    """Renames a feed and/or updates its exclusion status."""
    data = request.get_json()
    new_name = data.get('name')
    exclude_from_all = data.get('exclude_from_all')

    feed = Feed.query.get_or_404(feed_id)
    
    try:
        if new_name and new_name.strip():
            # Check for name uniqueness if it's being changed
            existing = Feed.query.filter(Feed.title == new_name.strip(), Feed.id != feed_id).first()
            if existing:
                return jsonify({'error': 'Feed with this name already exists'}), 400
            feed.title = new_name.strip()
            
        if exclude_from_all is not None:
            feed.exclude_from_all = bool(exclude_from_all)
            
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error updating feed: {e}")
        return jsonify({'error': str(e)}), 500

## --- NEW: Bulk Feed Assignment Endpoint ---
@app.route('/api/assign_feeds_bulk', methods=['POST'])
def assign_feeds_bulk():
    """Moves a list of feeds to a new category and adds them to a list of streams."""
    data = request.get_json()
    feed_ids = data.get('feed_ids', [])
    category_id = data.get('category_id') # Can be None
    stream_ids = data.get('stream_ids', [])

    if not feed_ids:
        return jsonify({'error': 'No feed IDs provided'}), 400
    
    try:
        # Get all feeds
        feeds = Feed.query.filter(Feed.id.in_(feed_ids)).all()
        if not feeds:
            return jsonify({'error': 'No valid feeds found'}), 404
        
        # 1. Move to new category (if provided)
        if category_id:
            category = Category.query.get(category_id)
            if not category:
                return jsonify({'error': 'Invalid category ID'}), 404
            
            for feed in feeds:
                feed.category_id = category_id
        
        # 2. Add to streams (if provided)
        if stream_ids:
            streams = CustomStream.query.filter(CustomStream.id.in_(stream_ids)).all()
            
            for feed in feeds:
                for stream in streams:
                    # Add only if not already in the stream
                    if feed not in stream.feeds:
                        stream.feeds.append(feed)

        db.session.commit()
        return jsonify({'success': True}), 200

    except Exception as e:
        db.session.rollback()
        print(f"Error in bulk feed assignment: {e}")
        return jsonify({'error': str(e)}), 500


## --- API: Category Management ---

@app.route('/api/add_category', methods=['POST'])
def add_category():
    """Adds a new category."""
    data = request.get_json()
    name = data.get('name')

    if not name or not name.strip():
        return jsonify({'error': 'Category name is required'}), 400
        
    existing = Category.query.filter_by(name=name.strip()).first()
    if existing:
        return jsonify({'error': 'Category with this name already exists'}), 400
        
    try: 
        new_category = Category(name=name.strip())
        db.session.add(new_category)
        db.session.commit()
        return jsonify({'id': new_category.id, 'name': new_category.name}), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route('/api/category/<int:category_id>', methods=['DELETE'])
def delete_category(category_id):
    """Deletes a category and moves its feeds to 'Uncategorized'."""
    category = Category.query.get_or_404(category_id)
    uncategorized = Category.query.filter_by(name='Uncategorized').first()

    if not uncategorized or category.id == uncategorized.id:
        return jsonify({'error': "Cannot delete the 'Uncategorized' category"}), 400
        
    try:
        for feed in category.feeds.all():
            feed.category_id = uncategorized.id
            
        db.session.delete(category)
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error deleting category: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/category/<int:category_id>', methods=['PUT'])
def update_category_settings(category_id):
    """Renames a category and/or updates exclusion status for its feeds."""
    data = request.get_json()
    new_name = data.get('name')
    feed_exclusion_states = data.get('feed_exclusion_states') # e.g., {"1": true, "2": false}

    category = Category.query.get_or_404(category_id)
    
    if category.name == 'Uncategorized' and new_name and new_name.strip() != 'Uncategorized':
         return jsonify({'error': "Cannot rename 'Uncategorized'"}), 400

    try:
        if new_name and new_name.strip():
            # Check for name uniqueness if it's being changed
            existing = Category.query.filter(Category.name == new_name.strip(), Category.id != category_id).first()
            if existing:
                return jsonify({'error': 'Category with this name already exists'}), 400
            category.name = new_name.strip()
        
        if feed_exclusion_states is not None:
            # Get all feed IDs we need to update
            feed_ids = [int(k) for k in feed_exclusion_states.keys()]
            if feed_ids:
                # Get the actual Feed objects that belong to this category
                feeds_to_update = Feed.query.filter(
                    Feed.category_id == category_id,
                    Feed.id.in_(feed_ids)
                ).all()
                
                # Update each feed
                for feed in feeds_to_update:
                    feed.exclude_from_all = bool(feed_exclusion_states.get(str(feed.id)))

        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error updating category: {e}")
        return jsonify({'error': str(e)}), 500

## --- API: Stream Management ---

@app.route('/api/add_custom_stream', methods=['POST'])
def add_stream():
    """Adds a new custom stream."""
    data = request.get_json()
    name = data.get('name')

    if not name or not name.strip():
        return jsonify({'error': 'Stream name is required'}), 400
    if CustomStream.query.filter_by(name=name.strip()).first():
        return jsonify({'error': 'Stream with this name already exists'}), 400
        
    try: 
        new_stream = CustomStream(name=name.strip())
        db.session.add(new_stream)
        db.session.commit()
        return jsonify({'id': new_stream.id, 'name': new_stream.name}), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route('/api/custom_stream/<int:stream_id>', methods=['DELETE'])
def soft_delete_stream(stream_id):
    """Soft deletes a custom stream."""
    stream = CustomStream.query.get_or_404(stream_id)
    if stream.deleted_at is not None:
        return jsonify({'message': 'Stream already marked for deletion'}), 200
    try:
        stream.deleted_at = datetime.datetime.now()
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error soft deleting stream: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/custom_stream/<int:stream_id>/permanent', methods=['DELETE'])
def permanent_delete_stream(stream_id):
    """Permanently deletes a custom stream and its feed associations."""
    stream = CustomStream.query.get_or_404(stream_id)
    try: 
        stream.feeds.clear()
        db.session.delete(stream)
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error permanently deleting stream: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/custom_stream/<int:stream_id>/restore', methods=['POST'])
def restore_stream(stream_id):
    """Restores a soft-deleted custom stream."""
    stream = CustomStream.query.get_or_404(stream_id)
    if stream.deleted_at is None:
        return jsonify({'message': 'Stream is not marked for deletion'}), 200
    try:
        stream.deleted_at = None
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error restoring stream: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/custom_stream/add_feed', methods=['POST'])
def add_feed_to_stream():
    """Adds a feed to a custom stream."""
    data = request.get_json()
    stream_id = data.get('custom_stream_id')
    feed_id = data.get('feed_id')

    if not stream_id or not feed_id:
        return jsonify({'error': 'Missing data'}), 400
        
    stream = CustomStream.query.get_or_404(stream_id)
    feed = Feed.query.get_or_404(feed_id)

    if feed.deleted_at is not None:
        return jsonify({'error': 'Cannot add a removed feed to a stream'}), 400
    if feed in stream.feeds:
        return jsonify({'message': 'Feed already in stream'}), 200
        
    try:
        stream.feeds.append(feed)
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500
    
@app.route('/api/custom_stream/<int:stream_id>/feed/<int:feed_id>', methods=['DELETE'])
def remove_feed_from_stream(stream_id, feed_id):
    """Removes a feed from a custom stream."""
    stream = CustomStream.query.get_or_404(stream_id)
    feed = Feed.query.get_or_404(feed_id)
    
    if feed not in stream.feeds:
        return jsonify({'message': 'Feed not in stream'}), 200

    try:
        stream.feeds.remove(feed)
        db.session.commit()
        return jsonify({'success': True}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error removing feed from stream: {e}")
        return jsonify({'error': str(e)}), 500

## --- API: Article Actions ---

@app.route('/api/article/<int:article_id>/favorite', methods=['POST'])
def toggle_favorite(article_id):
    """Toggles the 'is_favorite' status of an article."""
    article = Article.query.get_or_404(article_id)
    article.is_favorite = not article.is_favorite
    db.session.commit()
    return jsonify({'is_favorite': article.is_favorite})

@app.route('/api/article/<int:article_id>/bookmark', methods=['POST'])
def toggle_bookmark(article_id):
    """TToggles the 'is_read_later' status of an article."""
    article = Article.query.get_or_404(article_id)
    article.is_read_later = not article.is_read_later
    db.session.commit()
    return jsonify({'is_read_later': article.is_read_later})

## --- Main Execution ---

# Ensure the data directory exists
if 'DATA_DIR' in os.environ and not os.path.exists(data_dir):
    print(f"Creating data directory: {data_dir}")
    os.makedirs(data_dir)
    
# Initialize the database (this will now run when Gunicorn starts)
# We ONLY call this if not running with Gunicorn,
# as the entrypoint.sh will handle init.
if __name__ == '__main__':
    if 'DATA_DIT' in os.environ and not os.path.exists(data_dir):
        print(f"Creating data directory: {data_dir}")
        os.makedirs(data_dir)
    initialize_database()
    debug_mode = os.environ.get('FLASK_DEBUG') == '1'
    app.run(debug=debug_gid, host='0.0.0.0', port=5000)