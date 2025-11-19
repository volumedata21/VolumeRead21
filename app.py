import os
import re
import html
import datetime
import requests
from urllib.parse import urljoin, urlencode, quote
from concurrent.futures import ThreadPoolExecutor

import feedparser
from bs4 import BeautifulSoup
from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import or_
from sqlalchemy.orm import joinedload
from sqlalchemy.sql import func
from flask_migrate import Migrate

# --- App Configuration ---
basedir = os.path.abspath(os.path.dirname(__file__))
data_dir = os.environ.get('DATA_DIR', basedir)
db_path = os.path.join(data_dir, "app.db")

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)
migrate = Migrate(app, db)

# --- Database Models ---

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
    exclude_from_all = db.Column(db.Boolean, default=False, nullable=False)
    etag = db.Column(db.String(200), nullable=True)
    last_modified = db.Column(db.String(200), nullable=True)
    custom_streams = db.relationship('CustomStream', secondary=custom_stream_feeds, lazy='dynamic', back_populates='feeds')

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
    feeds = db.relationship('Feed', secondary=custom_stream_feeds, lazy='dynamic', back_populates='custom_streams')
    deleted_at = db.Column(db.DateTime(timezone=False), nullable=True)

# --- Helper Functions ---

def clean_text(text, strip_html_tags=True):
    """Unescapes HTML and removes common feed artifacts."""
    if not text:
        return ""
    text = html.unescape(text)
    text = text.replace('[…]', '').replace('&hellip;', '').replace('...', '').strip()
    if strip_html_tags:
        text = re.sub('<[^<]+?>', '', text)
    return text

def smart_truncate(content, length=300, suffix='...'):
    """Truncates a string respecting word boundaries."""
    if len(content) <= length:
        return content
    last_space = content.rfind(' ', 0, length)
    if last_space == -1:
        return content[:length] + suffix
    return content[:last_space] + suffix

def find_image_url(entry):
    """Attempts to find the best-quality image URL from a feed entry."""
    best_image_url = None
    max_width = -1
    image_sources = []
    
    if 'media_thumbnail' in entry and entry.media_thumbnail:
        thumbnails = entry.media_thumbnail if isinstance(entry.media_thumbnail, list) else [entry.media_thumbnail]
        image_sources.extend(thumbnails)
        
    if 'media_content' in entry and entry.media_content:
        contents = entry.media_content if isinstance(entry.media_content, list) else [entry.media_content]
        image_sources.extend(contents)

    if 'enclosures' in entry and entry.enclosures:
        enclosures = entry.enclosures if isinstance(entry.enclosures, list) else [entry.enclosures]
        for enc in enclosures:
            if isinstance(enc, dict) and 'image' in enc.get('type', ''):
                image_sources.append({'url': enc.get('href'), 'width': 0})

    for image in image_sources:
        if not isinstance(image, dict): continue
        url = image.get('url')
        if not url: continue
        if 'medium' in image and image.get('medium') != 'image': continue
            
        try:
            width = int(image.get('width', 0))
            if width > max_width:
                max_width = width
                best_image_url = url
            elif width == 0 and best_image_url is None:
                best_image_url = url
        except (ValueError, TypeError):
            if best_image_url is None:
                 best_image_url = url

    if best_image_url:
        return best_image_url

    # Scrape from HTML content as last resort
    html_content = next((item['value'] for item in entry.get('content', []) if 'value' in item), None) or entry.get('summary', '')
    if html_content:
        match = re.search(r'<img [^>]*src="([^"]+)"', html_content)
        if match:
            return match.group(1)
    
    return None

def _update_articles_for_feed(feed_instance, feed_data):
    """Parses feed data and adds new articles to the database."""
    added_count = 0
    is_youtube_feed = 'youtube.com' in feed_instance.url
    is_dailymotion_feed = 'dailymotion.com' in feed_instance.url

    for entry in feed_data.entries:
        if Article.query.filter_by(link=entry.link).first():
            continue

        published_time = datetime.datetime.now()
        if 'published_parsed' in entry and entry.published_parsed:
            try:
                published_time = datetime.datetime(*entry.published_parsed[:6])
            except ValueError:
                pass 

        content_html = next((item['value'] for item in entry.get('content', []) if 'value' in item), entry.get('summary', ''))
        summary_text = clean_text(entry.get('summary', ''), strip_html_tags=True)
        if not summary_text and content_html:
            summary_text = clean_text(content_html, strip_html_tags=True)
        
        smart_summary = smart_truncate(summary_text, length=300)
        
        # Title Extraction
        raw_title = entry.get('title', 'Untitled Article')
        clean_title = clean_text(raw_title, strip_html_tags=True)
        generic_titles = ['tik tok', 'tiktok', 'video', 'untitled article', 'untitled']
        
        if clean_title.lower().strip() in generic_titles:
            soup = BeautifulSoup(content_html, 'html.parser')
            text_content = soup.get_text(separator=' ', strip=True)
            if text_content:
                clean_title = smart_truncate(text_content, length=100)

        # Thumbnail Extraction
        image_url_found = None
        if is_youtube_feed:
            try:
                video_id_match = re.search(r'(?:watch\?v=|shorts\/)([a-zA-Z0-9_-]+)', entry.link)
                if video_id_match:
                    video_id = video_id_match.group(1)
                    image_url_found = f'https://img.youtube.com/vi/{video_id}/maxresdefault.jpg'
            except Exception as e:
                print(f"Error extracting YouTube video ID: {e}")
        elif is_dailymotion_feed:
            try:
                dm_id_match = re.search(r'/video/([a-zA-Z0-9]+)', entry.link)
                if dm_id_match:
                    dm_id = dm_id_match.group(1)
                    image_url_found = f'https://www.dailymotion.com/thumbnail/video/{dm_id}'
            except Exception as e:
                 print(f"Error extracting DailyMotion video ID: {e}")

        if not image_url_found:
            image_url_found = find_image_url(entry)
        
        # Pinterest Hi-Res Fix
        if image_url_found and 'i.pinimg.com' in image_url_found:
            hi_res_url = re.sub(r'\/(\d+x|236x)\/', '/originals/', image_url_found)
            if hi_res_url == image_url_found:
                hi_res_url = re.sub(r'\/(\d+x|236x)\/', '/736x/', image_url_found)
            image_url_found = hi_res_url if hi_res_url != image_url_found else image_url_found
        
        # Author Logic
        author_name = clean_text(entry.get('author', ''), strip_html_tags=True)
        if not author_name:
            author_name = clean_text(entry.get('dc_creator', ''), strip_html_tags=True)
        
        if (not author_name or author_name == 'Unknown Author') and (is_dailymotion_feed or 'tiktok' in feed_instance.url or 'vimeo' in feed_instance.url):
             author_name = feed_instance.title
        
        if not author_name:
            author_name = 'Unknown Author'

        new_article = Article(
            title=clean_title,
            link=entry.link,
            summary=smart_summary,
            full_content=clean_text(content_html, strip_html_tags=False),
            image_url=image_url_found,
            author=author_name,
            published=published_time,
            feed_id=feed_instance.id
        )
        db.session.add(new_article)
        added_count += 1
        
    if added_count > 0:
        db.session.commit()
    return added_count

def get_category_data(category):
    return {'id': category.id, 'name': category.name}

def get_rss_bridge_feed(base_url, target_url):
    """Queries RSS-Bridge to find or generate a feed URL."""
    try:
        find_url = f"{base_url}/?action=findbridge&url={quote(target_url)}"
        response = requests.get(find_url, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        bridge_name = data.get('bridge')
        params = data.get('parameters', {})

        if not bridge_name:
            return None

        query_params = {
            'action': 'display',
            'bridge': bridge_name,
            'format': 'Atom',
            **params
        }
        return f"{base_url}/?{urlencode(query_params)}"

    except Exception as e:
        print(f"RSS-Bridge Error: {e}")
        return None

def initialize_database():
    """Ensures tables and default category exist."""
    with app.app_context():
        db.create_all()
        if not Category.query.filter_by(name='Uncategorized').first():
            db.session.add(Category(name='Uncategorized'))
            db.session.commit()
            print("Created 'Uncategorized' category.")

# --- Routes ---

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/data')
def get_data():
    """Returns initial app state."""
    categories = Category.query.order_by(Category.name).all()
    active_feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    removed_feeds = Feed.query.filter(Feed.deleted_at.isnot(None)).order_by(Feed.deleted_at.desc()).all()
    active_streams = CustomStream.query.filter(CustomStream.deleted_at.is_(None)).order_by(CustomStream.name).all()
    removed_streams = CustomStream.query.filter(CustomStream.deleted_at.isnot(None)).order_by(CustomStream.deleted_at.desc()).all()
    stream_feed_links = db.session.query(custom_stream_feeds).all()

    return jsonify({
        'categories': [get_category_data(cat) for cat in categories],
        'feeds': [{'id': f.id, 'title': f.title, 'url': f.url, 'category_id': f.category_id, 'exclude_from_all': f.exclude_from_all} for f in active_feeds],
        'removedFeeds': [{'id': f.id, 'title': f.title, 'deleted_at': f.deleted_at.isoformat()} for f in removed_feeds],
        'customStreams': [{'id': cs.id, 'name': cs.name} for cs in active_streams],
        'removedStreams': [{'id': cs.id, 'name': cs.name, 'deleted_at': cs.deleted_at.isoformat()} for cs in removed_streams],
        'customStreamFeedLinks': [{'custom_stream_id': link.custom_stream_id, 'feed_id': link.feed_id} for link in stream_feed_links],
    })

@app.route('/api/articles')
def get_articles():
    """Returns paginated articles based on view context."""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 24, type=int)
    view_type = request.args.get('view_type', 'all')
    view_id = request.args.get('view_id', type=int)
    author_name = request.args.get('author_name', type=str)

    query = Article.query.order_by(Article.published.desc())
    is_reddit_source = False

    if view_type == 'feed' and view_id:
        query = query.filter(Article.feed_id == view_id)
        feed = Feed.query.get(view_id)
        if feed and ('reddit.com' in feed.url or 'lemmy.world' in feed.url):
            is_reddit_source = True
        
    elif view_type == 'category' and view_id:
        query = query.join(Feed).filter(Feed.category_id == view_id)
        category = Category.query.get(view_id)
        if category:
            active_feeds = category.feeds.filter(Feed.deleted_at.is_(None)).all()
            if active_feeds and all(('reddit.com' in f.url or 'lemmy.world' in f.url) for f in active_feeds):
                is_reddit_source = True
        
    elif view_type == 'custom_stream' and view_id:
        stream = CustomStream.query.get(view_id)
        if stream:
            feed_ids = [f.id for f in stream.feeds]
            if feed_ids:
                query = query.filter(Article.feed_id.in_(feed_ids))
                stream_feeds = Feed.query.filter(Feed.id.in_(feed_ids), Feed.deleted_at.is_(None)).all()
                if stream_feeds and all(('reddit.com' in f.url or 'lemmy.world' in f.url) for f in stream_feeds):
                    is_reddit_source = True
            else:
                query = query.filter(Article.id == -1) 
        
    elif view_type == 'favorites':
        query = query.filter(Article.is_favorite == True)
        
    elif view_type == 'readLater':
        query = query.filter(Article.is_read_later == True)
        
    elif view_type == 'author' and author_name:
        query = query.filter(Article.author == author_name)
    
    elif view_type == 'videos':
        query = query.join(Feed).filter(
            or_(
                Feed.url.like('%youtube.com%'),
                Feed.url.like('%vimeo.com%'),
                Feed.url.like('%dailymotion.com%'),
                Feed.url.like('%tiktok%')
            )
        )
    elif view_type == 'threads':
        query = query.join(Feed).filter(or_(Feed.url.like('%reddit.com%'), Feed.url.like('%lemmy.world%')))
        is_reddit_source = True

    elif view_type == 'all':
        query = query.join(Feed).filter(Feed.exclude_from_all == False)
    
    active_feed_ids_query = db.session.query(Feed.id).filter(Feed.deleted_at.is_(None))
    query = query.filter(Article.feed_id.in_(active_feed_ids_query))

    pagination = query.paginate(page=page, per_page=per_page, error_out=False)
    
    return jsonify({
        'articles': [
            {
                'id': a.id, 'title': a.title, 'link': a.link, 'summary': a.summary,
                'full_content': a.full_content, 'image_url': a.image_url, 'author': a.author,
                'published': a.published.isoformat() if a.published else datetime.datetime.now().isoformat(),
                'is_favorite': a.is_favorite, 'is_read_later': a.is_read_later,
                'feed_title': a.feed.title if a.feed else 'Unknown Feed', 
                'feed_id': a.feed_id
            } for a in pagination.items
        ],
        'total_pages': pagination.pages,
        'current_page': page,
        'has_next': pagination.has_next,
        'is_reddit_source': is_reddit_source
    })

@app.route('/api/add_feed', methods=['POST'])
def add_feed():
    """Adds a new feed with auto-discovery and URL correction."""
    data = request.get_json()
    url = (data.get('url') or '').strip()
    category_id = data.get('category_id')

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    # --- URL Normalization Handlers ---
    
    # Reddit
    try:
        reddit_match = re.match(r'(?:https?:\/\/)?(?:www\.)?reddit\.com\/r\/([a-zA-Z0-9_]+)\/?.*', url, re.IGNORECASE)
        if reddit_match:
            url = f'https://www.reddit.com/r/{reddit_match.group(1)}/.rss'
    except Exception: pass

    # Pinterest
    try:
        if 'pinterest.com' in url and not url.endswith('/feed.rss'):
            pinterest_match = re.match(r'(?:https?:\/\/)?(?:www\.)?pinterest\.com\/([a-zA-Z0-9_-]+)\/?.*', url, re.IGNORECASE)
            if pinterest_match:
                url = f'https://www.pinterest.com/{pinterest_match.group(1)}/feed.rss'
    except Exception: pass

    # Vimeo
    try:
        if 'vimeo.com' in url and 'rss' not in url:
            vimeo_match = re.match(r'(?:https?:\/\/)?(?:www\.)?vimeo\.com\/([a-zA-Z0-9_-]+)\/?$', url, re.IGNORECASE)
            if vimeo_match:
                url = f'https://vimeo.com/{vimeo_match.group(1)}/videos/rss'
    except Exception: pass

    # Dailymotion
    try:
        if 'dailymotion.com' in url and 'rss' not in url:
            dm_match = re.match(r'(?:https?:\/\/)?(?:www\.)?dailymotion\.com\/([a-zA-Z0-9_-]+)\/?.*', url, re.IGNORECASE)
            if dm_match and dm_match.group(1) not in ['video', 'playlist', 'rss']:
                url = f'https://www.dailymotion.com/rss/user/{dm_match.group(1)}'
    except Exception: pass

    # TikTok
    try:
        if 'tiktok.com' in url:
            rss_bridge_base_url = os.environ.get('RSS_BRIDGE_URL')
            if rss_bridge_base_url:
                tiktok_match = re.match(r'(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9_.]+)', url, re.IGNORECASE)
                if tiktok_match:
                    params = {
                        'action': 'display',
                        'bridge': 'TikTok',
                        'context': 'By user', 
                        'username': tiktok_match.group(1),
                        'format': 'Atom'
                    }
                    url = f"{rss_bridge_base_url}/?{urlencode(params)}"
    except Exception: pass
    
    # Lemmy
    try:
        lemmy_match = re.match(r'(?:https?:\/\/)?(?:www\.)?lemmy\.world\/c\/([a-zA-Z0-9_]+)(?:\/)?.*', url, re.IGNORECASE)
        if lemmy_match and '/feeds/' not in url:
            url = f'https://lemmy.world/feeds/c/{lemmy_match.group(1)}.xml'
    except Exception: pass

    # Ensure Category
    target_category = Category.query.get(category_id) if category_id else None
    if not target_category:
        target_category = Category.query.filter_by(name='Uncategorized').first()
        if not target_category:
            target_category = Category(name='Uncategorized')
            db.session.add(target_category)
            db.session.commit()

    try:
        feed_data = None
        feed_url = url
        headers = {'User-Agent': 'VolumeRead21-Feed-Finder/1.0'}
        
        if not feed_url.startswith(('http://', 'https://')):
            feed_url = 'https://' + feed_url

        # 1. Direct Parse
        parsed_data = feedparser.parse(feed_url, request_headers=headers)
        if parsed_data.feed and (parsed_data.entries or parsed_data.feed.get('title')):
            feed_data = parsed_data
        else:
            # 2. Common Suffixes
            base_url = feed_url.rstrip('/')
            for suffix in ['/feed', '/atom.xml', '/rss.xml', '/rss']:
                test_url = base_url + suffix
                parsed_data = feedparser.parse(test_url, request_headers=headers)
                if parsed_data.feed and (parsed_data.entries or parsed_data.feed.get('title')):
                    feed_data = parsed_data
                    feed_url = test_url
                    break
            
            # 3. HTML Discovery
            if not feed_data:
                try:
                    response = requests.get(feed_url, headers=headers, timeout=5)
                    if 'xml' in response.headers.get('Content-Type', '').lower():
                        feed_data = feedparser.parse(response.content, request_headers=headers)
                        feed_url = response.url
                    else:
                        soup = BeautifulSoup(response.text, 'html.parser')
                        link_tag = soup.find('link', {'rel': 'alternate', 'type': re.compile(r'application/(rss|atom)\+xml')})
                        if link_tag and link_tag.get('href'):
                            feed_url = urljoin(response.url, link_tag['href'])
                            feed_data = feedparser.parse(feed_url, request_headers=headers)
                except Exception: pass

        # 4. RSS-Bridge Fallback
        if not feed_data:
            rss_bridge_base_url = os.environ.get('RSS_BRIDGE_URL')
            if rss_bridge_base_url:
                bridge_url = get_rss_bridge_feed(rss_bridge_base_url, feed_url)
                if bridge_url:
                    feed_data = feedparser.parse(bridge_url, request_headers=headers)
                    feed_url = bridge_url

        if not feed_data or not feed_data.feed:
            return jsonify({'error': 'Could not find a valid feed.'}), 400

        if Feed.query.filter_by(url=feed_url).first():
            return jsonify({'error': 'Feed already exists.'}), 400

        feed_title = clean_text(feed_data.feed.get('title', 'Untitled Feed'), strip_html_tags=True)
        new_feed = Feed(
            title=feed_title, 
            url=feed_url, 
            category_id=target_category.id,
            etag=feed_data.get('etag'),
            last_modified=feed_data.get('modified')
        )
        db.session.add(new_feed)
        db.session.commit()

        _update_articles_for_feed(new_feed, feed_data)
        return jsonify({'success': True, 'title': feed_title}), 201

    except Exception as e:
        db.session.rollback()
        print(f"Error adding feed: {e}")
        return jsonify({'error': 'An unexpected error occurred.'}), 500

@app.route('/api/feed/<int:feed_id>', methods=['DELETE'])
def soft_delete_feed(feed_id):
    feed = Feed.query.get_or_404(feed_id)
    if feed.deleted_at: return jsonify({'message': 'Already deleted'}), 200
    feed.deleted_at = datetime.datetime.now()
    db.session.commit()
    return jsonify({'success': True}), 200

@app.route('/api/feed/<int:feed_id>/permanent', methods=['DELETE'])
def permanent_delete_feed(feed_id):
    feed = Feed.query.get_or_404(feed_id)
    db.session.execute(custom_stream_feeds.delete().where(custom_stream_feeds.c.feed_id == feed_id))
    db.session.delete(feed)
    db.session.commit()
    return jsonify({'success': True}), 200

@app.route('/api/feed/<int:feed_id>/restore', methods=['POST'])
def restore_feed(feed_id):
    feed = Feed.query.get_or_404(feed_id)
    uncategorized = Category.query.filter_by(name='Uncategorized').first()
    if not uncategorized:
        uncategorized = Category(name='Uncategorized')
        db.session.add(uncategorized)
    feed.deleted_at = None
    feed.category_id = uncategorized.id 
    db.session.commit()
    return jsonify({'success': True}), 200

def _fetch_one_feed(feed):
    """Worker function for parallel feed refreshing."""
    try:
        headers = { 'User-Agent': 'VolumeRead21-Feed-Refresher/1.0' }
        feed_data = feedparser.parse(feed.url, request_headers=headers, etag=feed.etag, modified=feed.last_modified)
        
        if feed_data.status == 304: return (feed, None, None, None, None)
        if feed_data.status >= 400 or feed_data.status == 301:
            return (feed, None, f"Status {feed_data.status}", None, None)
            
        return (feed, feed_data, None, feed_data.get('etag'), feed_data.get('modified'))
    except Exception as e:
        return (feed, None, str(e), None, None)

@app.route('/api/refresh_all_feeds', methods=['POST'])
def refresh_all_feeds():
    feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    if not feeds: return jsonify({'success': True, 'added_count': 0})
    
    total_added = 0
    errors = []

    with ThreadPoolExecutor(max_workers=10) as executor:
        results = executor.map(_fetch_one_feed, feeds)
    
    for feed, feed_data, error, new_etag, new_modified in results:
        if error:
            errors.append(f"{feed.title}: {error}")
            continue
        
        feed_in_session = db.session.get(Feed, feed.id)
        if not feed_in_session: continue

        if new_etag: feed_in_session.etag = new_etag
        if new_modified: feed_in_session.last_modified = new_modified
        
        if feed_data:
            try:
                total_added += _update_articles_for_feed(feed_in_session, feed_data)
            except Exception as e:
                errors.append(f"{feed.title}: DB Error {e}")
                db.session.rollback()
    
    db.session.commit()
    return jsonify({'success': True, 'added_count': total_added, 'errors': errors})

@app.route('/api/move_feed', methods=['POST'])
def move_feed():
    data = request.get_json()
    feed = Feed.query.get_or_404(data.get('feed_id'))
    feed.category_id = data.get('new_category_id')
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/feed/<int:feed_id>', methods=['PUT'])
def update_feed_settings(feed_id):
    data = request.get_json()
    feed = Feed.query.get_or_404(feed_id)
    
    if data.get('name'):
        feed.title = data.get('name').strip()
    if data.get('exclude_from_all') is not None:
        feed.exclude_from_all = bool(data.get('exclude_from_all'))
        
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/assign_feeds_bulk', methods=['POST'])
def assign_feeds_bulk():
    data = request.get_json()
    feeds = Feed.query.filter(Feed.id.in_(data.get('feed_ids', []))).all()
    
    if data.get('category_id'):
        for feed in feeds: feed.category_id = data.get('category_id')
        
    if data.get('stream_ids'):
        streams = CustomStream.query.filter(CustomStream.id.in_(data.get('stream_ids'))).all()
        for feed in feeds:
            for stream in streams:
                if feed not in stream.feeds: stream.feeds.append(feed)

    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/add_category', methods=['POST'])
def add_category():
    name = request.get_json().get('name', '').strip()
    if not name: return jsonify({'error': 'Name required'}), 400
    if Category.query.filter_by(name=name).first(): return jsonify({'error': 'Exists'}), 400
    
    category = Category(name=name)
    db.session.add(category)
    db.session.commit()
    return jsonify({'id': category.id, 'name': category.name}), 201

@app.route('/api/category/<int:category_id>', methods=['DELETE'])
def delete_category(category_id):
    category = Category.query.get_or_404(category_id)
    uncategorized = Category.query.filter_by(name='Uncategorized').first()
    if not uncategorized or category.id == uncategorized.id: return jsonify({'error': 'Cannot delete default'}), 400
    
    for feed in category.feeds.all(): feed.category_id = uncategorized.id
    db.session.delete(category)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/category/<int:category_id>', methods=['PUT'])
def update_category_settings(category_id):
    data = request.get_json()
    category = Category.query.get_or_404(category_id)
    
    if data.get('name'): category.name = data.get('name').strip()
    
    if data.get('feed_exclusion_states'):
        for feed_id, state in data.get('feed_exclusion_states').items():
            feed = Feed.query.get(feed_id)
            if feed and feed.category_id == category_id:
                feed.exclude_from_all = bool(state)
                
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/add_custom_stream', methods=['POST'])
def add_stream():
    name = request.get_json().get('name', '').strip()
    if not name: return jsonify({'error': 'Name required'}), 400
    
    stream = CustomStream(name=name)
    db.session.add(stream)
    db.session.commit()
    return jsonify({'id': stream.id, 'name': stream.name}), 201

@app.route('/api/custom_stream/<int:stream_id>', methods=['DELETE'])
def soft_delete_stream(stream_id):
    stream = CustomStream.query.get_or_404(stream_id)
    stream.deleted_at = datetime.datetime.now()
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/custom_stream/<int:stream_id>/permanent', methods=['DELETE'])
def permanent_delete_stream(stream_id):
    stream = CustomStream.query.get_or_404(stream_id)
    stream.feeds.clear()
    db.session.delete(stream)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/custom_stream/<int:stream_id>/restore', methods=['POST'])
def restore_stream(stream_id):
    stream = CustomStream.query.get_or_404(stream_id)
    stream.deleted_at = None
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/custom_stream/add_feed', methods=['POST'])
def add_feed_to_stream():
    data = request.get_json()
    stream = CustomStream.query.get_or_404(data.get('custom_stream_id'))
    feed = Feed.query.get_or_404(data.get('feed_id'))
    if feed not in stream.feeds:
        stream.feeds.append(feed)
        db.session.commit()
    return jsonify({'success': True})
    
@app.route('/api/custom_stream/<int:stream_id>/feed/<int:feed_id>', methods=['DELETE'])
def remove_feed_from_stream(stream_id, feed_id):
    stream = CustomStream.query.get_or_404(stream_id)
    feed = Feed.query.get_or_404(feed_id)
    if feed in stream.feeds:
        stream.feeds.remove(feed)
        db.session.commit()
    return jsonify({'success': True})

@app.route('/api/article/<int:article_id>/favorite', methods=['POST'])
def toggle_favorite(article_id):
    article = Article.query.get_or_404(article_id)
    article.is_favorite = not article.is_favorite
    db.session.commit()
    return jsonify({'is_favorite': article.is_favorite})

@app.route('/api/article/<int:article_id>/bookmark', methods=['POST'])
def toggle_bookmark(article_id):
    article = Article.query.get_or_404(article_id)
    article.is_read_later = not article.is_read_later
    db.session.commit()
    return jsonify({'is_read_later': article.is_read_later})

# --- Main Execution ---

if __name__ == '__main__':
    if 'DATA_DIR' in os.environ and not os.path.exists(data_dir):
        os.makedirs(data_dir)
    initialize_database()
    app.run(debug=(os.environ.get('FLASK_DEBUG') == '1'), host='0.0.0.0', port=5000)