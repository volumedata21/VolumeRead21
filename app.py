## --- Imports ---
import re
import feedparser
import html
import datetime
import os
from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import joinedload
from sqlalchemy.sql import func

## --- App Setup ---
basedir = os.path.abspath(os.path.dirname(__file__))
# Use DATA_DIR env var for persistent storage, default to app directory
data_dir = os.environ.get('DATA_DIR', basedir)
db_path = os.path.join(data_dir, "app.db")

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
db = SQLAlchemy(app)

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
        
        new_article = Article(
            title=clean_text(entry.get('title', 'Untitled Article'), strip_html_tags=True),
            link=entry.link,
            summary=smart_summary,
            full_content=clean_text(content_html, strip_html_tags=False),
            image_url=find_image_url(entry),
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
    }

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
    """Returns all categories, feeds, articles, and streams as a single JSON object."""
    categories = Category.query.order_by(Category.name).all()
    structured_categories = [get_category_data(cat) for cat in categories]
    
    active_feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    removed_feeds = Feed.query.filter(Feed.deleted_at.isnot(None)).order_by(Feed.deleted_at.desc()).all()
    active_feed_ids = [f.id for f in active_feeds]
    articles = Article.query.filter(Article.feed_id.in_(active_feed_ids)).order_by(Article.published.desc()).all()
    
    active_streams = CustomStream.query.filter(CustomStream.deleted_at.is_(None)).order_by(CustomStream.name).all()
    removed_streams = CustomStream.query.filter(CustomStream.deleted_at.isnot(None)).order_by(CustomStream.deleted_at.desc()).all()
    
    stream_feed_links = db.session.query(custom_stream_feeds).all()

    return jsonify({
        'categories': structured_categories,
        'feeds': [{'id': f.id, 'title': f.title, 'category_id': f.category_id} for f in active_feeds],
        'removedFeeds': [{'id': f.id, 'title': f.title, 'deleted_at': f.deleted_at.isoformat()} for f in removed_feeds],
        'articles': [
            {
                'id': a.id, 'title': a.title, 'link': a.link, 'summary': a.summary,
                'full_content': a.full_content, 'image_url': a.image_url, 'author': a.author,
                'published': a.published.isoformat() if a.published else datetime.datetime.now().isoformat(),
                'is_favorite': a.is_favorite, 'is_read_later': a.is_read_later,
                # --- THIS IS THE FIX ---
                # Checks if a.feed exists before trying to access .title
                'feed_title': a.feed.title if a.feed else 'Unknown Feed', 
                'feed_id': a.feed_id
            } for a in articles
        ],
        'customStreams': [{'id': cs.id, 'name': cs.name} for cs in active_streams],
        'removedStreams': [{'id': cs.id, 'name': cs.name, 'deleted_at': cs.deleted_at.isoformat()} for cs in removed_streams],
        'customStreamFeedLinks': [{'custom_stream_id': link.custom_stream_id, 'feed_id': link.feed_id} for link in stream_feed_links],
    })

## --- API: Feed Management ---

@app.route('/api/add_feed', methods=['POST'])
def add_feed():
    """Adds a new feed from a URL."""
    data = request.get_json()
    url = data.get('url')
    category_id = data.get('category_id')

    if not url:
        return jsonify({'error': 'URL is required'}), 400
    if Feed.query.filter_by(url=url).first():
        return jsonify({'error': 'Feed already exists (might be in Removed Feeds)'}), 400

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
        feed_data = feedparser.parse(url)
        feed_title = clean_text(feed_data.feed.get('title', 'Untitled Feed'), strip_html_tags=True)
        
        new_feed = Feed(title=feed_title, url=url, category_id=target_category.id)
        db.session.add(new_feed)
        db.session.commit()
        
        _update_articles_for_feed(new_feed, feed_data)
        return jsonify({'success': True, 'title': feed_title}), 201
        
    except Exception as e:
        db.session.rollback()
        print(f"Error adding feed: {e}")
        return jsonify({'error': 'Could not parse feed. Invalid URL or format?'}), 500

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

@app.route('/api/refresh_all_feeds', methods=['POST'])
def refresh_all_feeds():
    """Refreshes all active feeds, fetching new articles."""
    feeds = Feed.query.filter(Feed.deleted_at.is_(None)).all()
    total_added = 0
    errors = []

    if not feeds:
        return jsonify({'success': True, 'message': 'No active feeds to refresh.', 'added_count': 0})
        
    for feed in feeds:
        try:
            feed_data = feedparser.parse(feed.url)
            if feed_data.status >= 400 or feed_data.status == 301:
                errors.append(f"Error fetching {feed.title}: Status {feed_data.status}")
                continue
            count = _update_articles_for_feed(feed, feed_data)
            total_added += count
        except Exception as e:
            errors.append(f"Error processing {feed.title}: {e}")
            print(f"Error refreshing feed {feed.url}: {e}")
            
    if errors:
        return jsonify({
            'success': False if len(errors) == len(feeds) else True,
            'message': f'Refreshed feeds, added {total_added} articles.',
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
def rename_category(category_id):
    """Renames a category."""
    data = request.get_json()
    new_name = data.get('name')

    if not new_name or not new_name.strip():
        return jsonify({'error': 'New name is required'}), 400
        
    category = Category.query.get_or_404(category_id)
    if category.name == 'Uncategorized':
        return jsonify({'error': "Cannot rename 'Uncategorized'"}), 400
        
    existing = Category.query.filter_by(name=new_name.strip()).first()
    if existing and existing.id != category_id:
        return jsonify({'error': 'Category with this name already exists'}), 400
        
    try:
        category.name = new_name.strip()
        db.session.commit()
        return jsonify({'success': True, 'name': new_name}), 200
    except Exception as e:
        db.session.rollback()
        print(f"Error renaming category: {e}")
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
    """Toggles the 'is_read_later' status of an article."""
    article = Article.query.get_or_404(article_id)
    article.is_read_later = not article.is_read_later
    db.session.commit()
    return jsonify({'is_read_later': article.is_read_later})

## --- Main Execution ---

if __name__ == '__main__':
    # Ensure the data directory exists
    if 'DATA_DIR' in os.environ and not os.path.exists(data_dir):
        print(f"Creating data directory: {data_dir}")
        os.makedirs(data_dir)
        
    initialize_database()
    
    # Use FLASK_DEBUG env var to control debug mode
    debug_mode = os.environ.get('FLASK_DEBUG') == '1'
    app.run(debug=debug_mode, host='0.0.0.0', port=5000)
