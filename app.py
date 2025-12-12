import os
import re
import html
import datetime
import requests
import xml.etree.ElementTree as ET
from urllib.parse import urljoin, urlencode, quote
from concurrent.futures import ThreadPoolExecutor

import feedparser
from bs4 import BeautifulSoup
from flask import Flask, render_template, request, jsonify, Response, make_response
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
    layout_style = db.Column(db.String(20), nullable=True) 
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
    layout_style = db.Column(db.String(20), nullable=True)
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
    is_read = db.Column(db.Boolean, default=False) # <--- NEW COLUMN
    feed_id = db.Column(db.Integer, db.ForeignKey('feed.id'), nullable=False)

class CustomStream(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False, unique=True)
    layout_style = db.Column(db.String(20), nullable=True)
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

        published_time = None
        for field in ['published_parsed', 'updated_parsed', 'created_parsed']:
            if field in entry and entry[field]:
                try:
                    published_time = datetime.datetime(*entry[field][:6])
                    break
                except ValueError: pass
        
        if not published_time:
            raw_date = entry.get('published') or entry.get('updated') or entry.get('created')
            if raw_date:
                try:
                    published_time = datetime.datetime.strptime(raw_date, '%Y-%m-%d')
                except ValueError:
                    try:
                        temp_time = datetime.datetime.strptime(raw_date, '%m-%d')
                        published_time = temp_time.replace(year=datetime.datetime.now().year)
                    except ValueError:
                        pass

        if not published_time:
            published_time = datetime.datetime.now()

        content_html = next((item['value'] for item in entry.get('content', []) if 'value' in item), entry.get('summary', ''))
        summary_text = clean_text(entry.get('summary', ''), strip_html_tags=True)
        if not summary_text and content_html:
            summary_text = clean_text(content_html, strip_html_tags=True)
        
        smart_summary = smart_truncate(summary_text, length=300)
        
        raw_title = entry.get('title', 'Untitled Article')
        clean_title = clean_text(raw_title, strip_html_tags=True)
        generic_titles = ['tik tok', 'tiktok', 'video', 'untitled article', 'untitled']
        
        if clean_title.lower().strip() in generic_titles:
            soup = BeautifulSoup(content_html, 'html.parser')
            text_content = soup.get_text(separator=' ', strip=True)
            if text_content:
                clean_title = smart_truncate(text_content, length=100)

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
        
        if image_url_found and 'i.pinimg.com' in image_url_found:
            hi_res_url = re.sub(r'\/(\d+x|236x)\/', '/originals/', image_url_found)
            if hi_res_url == image_url_found:
                hi_res_url = re.sub(r'\/(\d+x|236x)\/', '/736x/', image_url_found)
            image_url_found = hi_res_url if hi_res_url != image_url_found else image_url_found

        if image_url_found and 'behance.net' in image_url_found:
            image_url_found = image_url_found.replace('/projects/404/', '/projects/max_1200/')
        
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
    return {'id': category.id, 'name': category.name, 'layout_style': category.layout_style}

def get_rss_bridge_feed(base_url, target_url):
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
    with app.app_context():
        db.create_all()
        
        # --- NEW: Manual Column Migration Check ---
        # This ensures existing users get the 'is_read' column without deleting their DB
        inspector = db.inspect(db.engine)
        columns = [c['name'] for c in inspector.get_columns('article')]
        if 'is_read' not in columns:
            print("Migrating database: Adding 'is_read' column to Article table...")
            with db.engine.connect() as conn:
                conn.execute(db.text("ALTER TABLE article ADD COLUMN is_read BOOLEAN DEFAULT 0"))
                conn.commit()
        # ------------------------------------------

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
    categories = Category.query.order_by(Category.name).all()
    active_feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    removed_feeds = Feed.query.filter(Feed.deleted_at.isnot(None)).order_by(Feed.deleted_at.desc()).all()
    active_streams = CustomStream.query.filter(CustomStream.deleted_at.is_(None)).order_by(CustomStream.name).all()
    removed_streams = CustomStream.query.filter(CustomStream.deleted_at.isnot(None)).order_by(CustomStream.deleted_at.desc()).all()
    stream_feed_links = db.session.query(custom_stream_feeds).all()

    return jsonify({
        'categories': [get_category_data(cat) for cat in categories],
        'feeds': [{'id': f.id, 'title': f.title, 'url': f.url, 'category_id': f.category_id, 'exclude_from_all': f.exclude_from_all, 'layout_style': f.layout_style} for f in active_feeds],
        'removedFeeds': [{'id': f.id, 'title': f.title, 'deleted_at': f.deleted_at.isoformat()} for f in removed_feeds],
        'customStreams': [{'id': cs.id, 'name': cs.name, 'layout_style': cs.layout_style} for cs in active_streams],
        'removedStreams': [{'id': cs.id, 'name': cs.name, 'deleted_at': cs.deleted_at.isoformat()} for cs in removed_streams],
        'customStreamFeedLinks': [{'custom_stream_id': link.custom_stream_id, 'feed_id': link.feed_id} for link in stream_feed_links],
    })

@app.route('/api/articles')
def get_articles():
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 24, type=int)
    view_type = request.args.get('view_type', 'all')
    view_id = request.args.get('view_id', type=int)
    author_name = request.args.get('author_name', type=str)
    # *** NEW: Get unread_only param ***
    unread_only = request.args.get('unread_only') == 'true'

    query = Article.query.order_by(Article.published.desc())
    
    # *** NEW: Apply Filter ***
    if unread_only:
        query = query.filter(Article.is_read == False)
    is_reddit_source = False

    if view_type == 'feed' and view_id:
        query = query.filter(Article.feed_id == view_id)
        feed = Feed.query.get(view_id)
        if feed and ('reddit.com' in feed.url or 'lemmy.world' in feed.url):
            is_reddit_source = True
    elif view_type == 'category' and view_id:
        query = query.join(Feed).filter(Feed.category_id == view_id)
    elif view_type == 'custom_stream' and view_id:
        query = query.join(Feed).join(custom_stream_feeds).filter(custom_stream_feeds.c.custom_stream_id == view_id)
    elif view_type == 'favorites':
        query = query.filter(Article.is_favorite == True)
    elif view_type == 'readLater':
        query = query.filter(Article.is_read_later == True)
    elif view_type == 'author' and author_name:
        query = query.filter(Article.author == author_name)
    elif view_type == 'sites':
        query = query.join(Feed).filter(
            ~or_(
                Feed.url.like('%youtube.com%'),
                Feed.url.like('%vimeo.com%'),
                Feed.url.like('%dailymotion.com%'),
                Feed.url.like('%tiktok%'),
                Feed.url.like('%reddit.com%'),
                Feed.url.like('%lemmy.world%')
            )
        )
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
                'id': a.id, 
                'title': a.title, 
                'link': a.link, 
                'summary': a.summary,
                'full_content': a.full_content, 
                'image_url': a.image_url, 
                'author': a.author,
                'published': a.published.isoformat() if a.published else datetime.datetime.now().isoformat(),
                'is_favorite': a.is_favorite, 
                'is_read_later': a.is_read_later,
                'is_read': a.is_read,  # <--- NEW FIELD
                'feed_title': a.feed.title if a.feed else 'Unknown Feed', 
                'feed_id': a.feed_id
            } for a in pagination.items
        ],
        'total_pages': pagination.pages,
        'current_page': page,
        'has_next': pagination.has_next,
        'is_reddit_source': is_reddit_source
    })

@app.route('/api/article/<int:article_id>/mark_read', methods=['POST'])
def mark_read(article_id):
    article = Article.query.get_or_404(article_id)
    article.is_read = True
    db.session.commit()
    return jsonify({'success': True})

@app.route('/api/mark_all_read', methods=['POST'])
def mark_all_read():
    """Marks articles as read based on the current context (view_type/id)."""
    data = request.get_json()
    view_type = data.get('view_type', 'all')
    view_id = data.get('view_id')
    
    query = db.session.query(Article).filter(Article.is_read == False)
    
    # Apply same filters as get_articles
    if view_type == 'feed' and view_id:
        query = query.filter(Article.feed_id == view_id)
    elif view_type == 'category' and view_id:
        query = query.join(Feed).filter(Feed.category_id == view_id)
    elif view_type == 'custom_stream' and view_id:
        query = query.join(Feed).join(custom_stream_feeds).filter(custom_stream_feeds.c.custom_stream_id == view_id)
    elif view_type == 'all':
        query = query.join(Feed).filter(Feed.exclude_from_all == False)
    # (Add other filters like sites/videos if desired, generally 'all' or 'feed' is most common)

    # Bulk update
    updated_count = query.update({Article.is_read: True}, synchronize_session=False)
    db.session.commit()
    
    return jsonify({'success': True, 'updated_count': updated_count})

@app.route('/api/add_feed', methods=['POST'])
def add_feed():
    data = request.get_json()
    url = (data.get('url') or '').strip()
    category_id = data.get('category_id')

    if not url:
        return jsonify({'error': 'URL is required'}), 400

    try:
        reddit_match = re.match(r'(?:https?:\/\/)?(?:www\.)?reddit\.com\/r\/([a-zA-Z0-9_]+)\/?.*', url, re.IGNORECASE)
        if reddit_match:
            url = f'https://www.reddit.com/r/{reddit_match.group(1)}/.rss'
    except Exception: pass

    try:
        if 'pinterest.com' in url and not url.endswith('/feed.rss'):
            pinterest_match = re.match(r'(?:https?:\/\/)?(?:www\.)?pinterest\.com\/([a-zA-Z0-9_-]+)\/?.*', url, re.IGNORECASE)
            if pinterest_match:
                url = f'https://www.pinterest.com/{pinterest_match.group(1)}/feed.rss'
    except Exception: pass

    try:
        if 'vimeo.com' in url and 'rss' not in url:
            vimeo_match = re.match(r'(?:https?:\/\/)?(?:www\.)?vimeo\.com\/([a-zA-Z0-9_-]+)\/?$', url, re.IGNORECASE)
            if vimeo_match:
                url = f'https://vimeo.com/{vimeo_match.group(1)}/videos/rss'
    except Exception: pass

    try:
        if 'dailymotion.com' in url and 'rss' not in url:
            dm_match = re.match(r'(?:https?:\/\/)?(?:www\.)?dailymotion\.com\/([a-zA-Z0-9_-]+)\/?.*', url, re.IGNORECASE)
            if dm_match and dm_match.group(1) not in ['video', 'playlist', 'rss']:
                url = f'https://www.dailymotion.com/rss/user/{dm_match.group(1)}'
    except Exception: pass

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
    
    try:
        lemmy_match = re.match(r'(?:https?:\/\/)?(?:www\.)?lemmy\.world\/c\/([a-zA-Z0-9_]+)(?:\/)?.*', url, re.IGNORECASE)
        if lemmy_match and '/feeds/' not in url:
            url = f'https://lemmy.world/feeds/c/{lemmy_match.group(1)}.xml'
    except Exception: pass

    try:
        if 'behance.net' in url and 'feeds' not in url:
            behance_match = re.match(r'(?:https?:\/\/)?(?:www\.)?behance\.net\/([^\/\?]+)', url, re.IGNORECASE)
            if behance_match:
                url = f'https://www.behance.net/feeds/user?username={behance_match.group(1)}'
    except Exception: pass

    try:
        if 'deviantart.com' in url and 'backend.deviantart.com' not in url:
            da_match = re.match(r'(?:https?:\/\/)?(?:www\.)?deviantart\.com\/([^\/\?]+)', url, re.IGNORECASE)
            if da_match:
                username = da_match.group(1)
                url = f'https://backend.deviantart.com/rss.xml?type=deviation&q=by%3A{username}+sort%3Atime+meta%3Aall'
    except Exception: pass

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

        parsed_data = feedparser.parse(feed_url, request_headers=headers)
        if parsed_data.feed and (parsed_data.entries or parsed_data.feed.get('title')):
            feed_data = parsed_data
        else:
            base_url = feed_url.rstrip('/')
            for suffix in ['/feed', '/atom.xml', '/rss.xml', '/rss']:
                test_url = base_url + suffix
                parsed_data = feedparser.parse(test_url, request_headers=headers)
                if parsed_data.feed and (parsed_data.entries or parsed_data.feed.get('title')):
                    feed_data = parsed_data
                    feed_url = test_url
                    break
            
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

def _fetch_one_feed(args):
    """Worker function for parallel feed refreshing. args is (feed, force_refresh)"""
    feed, force_refresh = args
    try:
        # Use a real Browser User-Agent to avoid blocking
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        
        if force_refresh:
            feed_data = feedparser.parse(feed.url, request_headers=headers, etag=None, modified=None)
        else:
            feed_data = feedparser.parse(feed.url, request_headers=headers, etag=feed.etag, modified=feed.last_modified)
        
        # *** FIX: Add flush=True to force the log out immediately ***
        status_code = feed_data.status if hasattr(feed_data, 'status') else 'Unknown'
        print(f"Checking {feed.title} ({feed.url})... Status: {status_code}", flush=True)

        if hasattr(feed_data, 'status'):
            if feed_data.status == 304: return (feed, None, None, None, None)
            # *** FIX: Allow 301/302 Redirects. Only block 4xx/5xx errors ***
            if feed_data.status >= 400:
                return (feed, None, f"Status {feed_data.status}", None, None)
            
        return (feed, feed_data, None, feed_data.get('etag'), feed_data.get('modified'))
    except Exception as e:
        # *** FIX: Print errors too ***
        print(f"Error checking {feed.title}: {e}", flush=True)
        return (feed, None, str(e), None, None)

@app.route('/api/refresh_all_feeds', methods=['POST'])
def refresh_all_feeds():
    feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    if not feeds: return jsonify({'success': True, 'added_count': 0})
    
    # Check if this is a forced refresh from the frontend
    data = request.get_json() or {}
    force_refresh = data.get('force', False)
    
    total_added = 0
    errors = []

    # Map expects a single iterable, so we zip feeds with the force flag
    feed_args = [(f, force_refresh) for f in feeds]

    with ThreadPoolExecutor(max_workers=10) as executor:
        results = executor.map(_fetch_one_feed, feed_args)
    
    for feed, feed_data, error, new_etag, new_modified in results:
        if error:
            errors.append(f"{feed.title}: {error}")
            continue
        
        feed_in_session = db.session.get(Feed, feed.id)
        if not feed_in_session: continue

        # Only update cache headers if we actually got data back
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
    if 'layout_style' in data:
        feed.layout_style = data.get('layout_style')
        
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
    
    if 'layout_style' in data:
        category.layout_style = data.get('layout_style')
                
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

@app.route('/api/custom_stream/<int:stream_id>', methods=['PUT'])
def update_stream_settings(stream_id):
    data = request.get_json()
    stream = CustomStream.query.get_or_404(stream_id)
    
    if data.get('name'):
        new_name = data.get('name').strip()
        if new_name != stream.name:
             if CustomStream.query.filter_by(name=new_name).first():
                 return jsonify({'error': 'Stream with this name already exists'}), 400
             stream.name = new_name
    
    if 'layout_style' in data:
        stream.layout_style = data.get('layout_style')

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

@app.route('/api/export_opml')
def export_opml():
    categories = Category.query.order_by(Category.name).all()
    
    root = ET.Element('opml', version="1.0")
    head = ET.SubElement(root, 'head')
    ET.SubElement(head, 'title').text = 'VolumeRead21 Feeds Export'
    ET.SubElement(head, 'dateCreated').text = datetime.datetime.now().strftime("%a, %d %b %Y %H:%M:%S GMT")
    
    body = ET.SubElement(root, 'body')
    
    for category in categories:
        cat_outline = ET.SubElement(body, 'outline', text=category.name, title=category.name)
        
        feeds = category.feeds.all()
        if not feeds:
            continue
            
        for feed in feeds:
            ET.SubElement(cat_outline, 'outline', 
                          type="rss", 
                          text=feed.title, 
                          title=feed.title, 
                          xmlUrl=feed.url, 
                          htmlUrl=feed.url) 

    xml_str = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding='unicode')
    
    response = make_response(xml_str)
    response.headers["Content-Disposition"] = "attachment; filename=volumeread21_feeds.opml"
    response.headers["Content-Type"] = "application/xml"
    return response

@app.route('/api/import_opml', methods=['POST'])
def import_opml():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    try:
        tree = ET.parse(file)
        root = tree.getroot()
        body = root.find('body')
        
        added_feeds = 0
        added_categories = 0
        
        def process_outline(outline, current_category_id=None):
            nonlocal added_feeds, added_categories
            
            text = outline.get('text') or outline.get('title') or 'Untitled'
            xml_url = outline.get('xmlUrl')
            
            if xml_url:
                if not Feed.query.filter_by(url=xml_url).first():
                    target_cat_id = current_category_id
                    if not target_cat_id:
                        uncat = Category.query.filter_by(name='Uncategorized').first()
                        if not uncat:
                            uncat = Category(name='Uncategorized')
                            db.session.add(uncat)
                            db.session.commit()
                        target_cat_id = uncat.id
                    
                    new_feed = Feed(title=text, url=xml_url, category_id=target_cat_id)
                    db.session.add(new_feed)
                    added_feeds += 1

            elif list(outline): 
                category = Category.query.filter_by(name=text).first()
                if not category:
                    category = Category(name=text)
                    db.session.add(category)
                    db.session.commit()
                    added_categories += 1
                
                for child in outline:
                    process_outline(child, category.id)

        if body is not None:
            for outline in body:
                process_outline(outline)
        
        db.session.commit()
        return jsonify({
            'success': True, 
            'message': f'Successfully imported {added_feeds} feeds and {added_categories} categories.'
        })

    except ET.ParseError:
        return jsonify({'error': 'Invalid OPML file format'}), 400
    except Exception as e:
        print(f"Import Error: {e}")
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

# *** NEW: Database Cleanup Route ***
@app.route('/api/maintenance/cleanup', methods=['POST'])
def cleanup_articles():
    """Deletes articles older than 'days' (default 30) that are NOT favorites or bookmarks."""
    days = request.get_json().get('days', 30)
    cutoff_date = datetime.datetime.now() - datetime.timedelta(days=days)
    
    try:
        deleted_count = Article.query.filter(
            Article.published < cutoff_date,
            Article.is_favorite == False,
            Article.is_read_later == False
        ).delete(synchronize_session=False)
        
        db.session.commit()
        db.session.execute(db.text("VACUUM"))
        
        return jsonify({'success': True, 'deleted_count': deleted_count, 'message': f"Cleaned {deleted_count} old articles."})
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    if 'DATA_DIR' in os.environ and not os.path.exists(data_dir):
        os.makedirs(data_dir)
    initialize_database()
    app.run(debug=(os.environ.get('FLASK_DEBUG') == '1'), host='0.0.0.0', port=5000)