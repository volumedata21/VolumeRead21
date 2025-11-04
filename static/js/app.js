function rssApp() {
    return {
        // --- State Variables ---
        isMobileMenuOpen: false,
        isModalOpen: false,
        isRefreshing: false,
        newFeedUrl: '',
        feedError: '',
        newCategoryName: '',
        categoryError: '',
        newCustomStreamName: '',
        customStreamError: '',
        openCategoryIDs: [],
        openStreamIDs: [],
        currentView: { type: 'all', id: null, author: null },
        currentTitle: 'All Feeds',
        modalArticle: null,
        searchQuery: '',
        sortOrder: 'newest',
        copiedArticleId: null,
        appData: {
            categories: [],
            feeds: [],
            articles: [],
            removedFeeds: [],
            customStreams: [],
            customStreamFeedLinks: [],
            removedStreams: []
        },
        draggingFeedId: null,
        dragOverCategoryId: null,
        dragOverStreamId: null,
        touchDragging: false,
        articlesToShow: 75,
        pressTimer: null,
        touchStartX: 0,
        touchStartY: 0,
        touchStartEvent: null,

        // --- Init ---
        init() {
            this.firstLoad(); // Use firstLoad to prevent re-opening "Uncategorized"
            setInterval(() => this.refreshAllFeeds(true), 300000); // 5-minute refresh
            
            // Add global touch listeners for mobile drag/drop
            // Use $root to ensure it's the main component element
            this.$root.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
            this.$root.addEventListener('touchend', this.handleTouchEnd.bind(this));
        },
        
        async firstLoad() {
            await this.fetchData();
            // This logic now only runs ONCE on page load
            const uncategorized = (this.appData.categories || []).find(c => c.name === 'Uncategorized');
            if (uncategorized && (this.appData.feeds || []).some(f => f.category_id === uncategorized.id) && !this.openCategoryIDs.includes(uncategorized.id)) {
                this.openCategoryIDs.push(uncategorized.id);
            }
        },

        // --- Computed Properties (Getters) ---
        get fullFilteredList() {
            let articles = [];
            const viewType = this.currentView.type;
            const viewId = this.currentView.id;
            const viewAuthor = this.currentView.author;

            if (viewType === 'all') {
                articles = this.appData.articles;
            } else if (viewType === 'favorites') {
                articles = this.appData.articles.filter(a => a.is_favorite);
            } else if (viewType === 'readLater') {
                articles = this.appData.articles.filter(a => a.is_read_later);
            } else if (viewType === 'feed') {
                articles = this.appData.articles.filter(a => a.feed_id === viewId);
            } else if (viewType === 'custom_stream') {
                const feedIdsInStream = (this.appData.customStreamFeedLinks || []).filter(l => l.custom_stream_id === viewId).map(l => l.feed_id);
                articles = this.appData.articles.filter(a => feedIdsInStream.includes(a.feed_id));
            } else if (viewType === 'category') {
                const feedIdsInCategory = (this.appData.feeds || []).filter(f => f.category_id === viewId).map(f => f.id);
                articles = this.appData.articles.filter(a => feedIdsInCategory.includes(a.feed_id));
            } else if (viewType === 'author') {
                articles = this.appData.articles.filter(a => a.author && a.author === viewAuthor);
            }

            if (this.searchQuery.trim() !== '') {
                const query = this.searchQuery.toLowerCase();
                articles = articles.filter(a =>
                    (a.title && a.title.toLowerCase().includes(query)) ||
                    (a.summary && a.summary.toLowerCase().includes(query)) ||
                    (a.author && a.author.toLowerCase().includes(query)) ||
                    (a.feed_title && a.feed_title.toLowerCase().includes(query)) // Search feed title
                );
            }

            articles.sort((a, b) => {
                const dateA = a.published ? new Date(a.published) : 0;
                const dateB = b.published ? new Date(b.published) : 0;
                return this.sortOrder === 'newest' ? dateB - dateA : dateA - b;
            });
            
            return articles;
        },

        get filteredArticles() {
            return this.fullFilteredList.slice(0, this.articlesToShow);
        },

        getEmptyMessage() {
            if (this.isRefreshing && (!this.appData.feeds || this.appData.feeds.length === 0)) return 'Loading feeds...';
            if (this.searchQuery.trim() !== '') return 'No articles match your search.';
            if (!this.appData.feeds || this.appData.feeds.length === 0) {
                if ((!this.appData.removedFeeds || this.appData.removedFeeds.length === 0) && (!this.appData.removedStreams || this.appData.removedStreams.length === 0)) {
                    return 'Add a feed URL above to get started!';
                } else {
                    return 'No active feeds. Add one above or restore one from "Removed Feeds".';
                }
            }
            if (this.currentView.type === 'author') return `No articles found for author: ${this.currentView.author || 'Unknown'}.`;
            if (this.currentView.type === 'custom_stream') {
                const streamFeeds = this.getFeedsInStream(this.currentView.id);
                if (streamFeeds.length === 0) return `Drag feeds into this stream to see articles.`;
                else if (this.fullFilteredList.length === 0) return `No articles found for stream: ${this.currentTitle}.`;
            }
            if (this.currentView.type === 'category') {
                if (this.getFeedsInCategory(this.currentView.id).length === 0) return `Drag feeds into this category.`;
                else if (this.fullFilteredList.length === 0) return `No articles found for category: ${this.currentTitle}.`;
            }
            if (this.filteredArticles.length === 0 && this.fullFilteredList.length > 0) return 'All articles loaded for this view.'
            if (this.fullFilteredList.length === 0) return 'No articles found for this view.';
            return 'No articles found.'; // Fallback
        },

        getFeedTitle(feedId) {
            let feed = (this.appData.feeds || []).find(f => f.id === feedId);
            if (feed) return feed.title;
            let rFeed = (this.appData.removedFeeds || []).find(f => f.id === feedId);
            return rFeed ? rFeed.title : '...';
        },

        getFeedsInStream(streamId) {
            const feedIds = (this.appData.customStreamFeedLinks || []).filter(l => l.custom_stream_id === streamId).map(l => l.feed_id);
            return feedIds.map(id => (this.appData.feeds || []).find(f => f.id === id)).filter(Boolean);
        },

        getCategoryName(catId) {
            const cat = (this.appData.categories || []).find(c => c.id === catId);
            return cat ? cat.name : '...';
        },

        getFeedsInCategory(catId) {
            return (this.appData.feeds || []).filter(f => f.category_id === catId);
        },

        // --- UI Actions ---
        setView(type, id = null, author = null) {
            this.currentView = { type: type, id: id, author: author };
            this.updateTitle();
            this.isMobileMenuOpen = false;
            this.articlesToShow = 75; // Reset count when changing views
        },

        updateTitle() {
            const { type, id, author } = this.currentView;
            if (type === 'all') { this.currentTitle = 'All Feeds'; }
            else if (type === 'favorites') { this.currentTitle = 'Favorites'; }
            else if (type === 'readLater') { this.currentTitle = 'Read Later'; }
            else if (type === 'feed') { this.currentTitle = this.getFeedTitle(id) || 'Feed'; }
            else if (type === 'custom_stream') { const s = (this.appData.customStreams || []).find(s => s.id === id); this.currentTitle = s ? s.name : 'Stream'; }
            else if (type === 'category') { this.currentTitle = this.getCategoryName(id) || 'Category'; }
            else if (type === 'author') { this.currentTitle = `Author: ${author || 'Unknown'}`; }
            else { this.currentTitle = 'All Feeds'; }
        },

        loadMoreArticles() {
            this.articlesToShow += 75;
        },

        openModal(article) {
            this.modalArticle = article;
            this.isModalOpen = true;
        },

        toggleStream(id) {
            const index = this.openStreamIDs.indexOf(id);
            if (index === -1) this.openStreamIDs.push(id);
            else this.openStreamIDs.splice(index, 1);
        },

        toggleCategory(id) {
            const index = this.openCategoryIDs.indexOf(id);
            if (index === -1) this.openCategoryIDs.push(id);
            else this.openCategoryIDs.splice(index, 1);
        },

        // --- Content Rendering ---
        renderModalContent(article) {
            let content = article.full_content || article.summary || '';

            if (article.image_url) {
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(content, 'text/html');
                    const firstImg = doc.querySelector('img');
                    if (firstImg && (firstImg.src === article.image_url || firstImg.getAttribute('src') === article.image_url || firstImg.src.split('?')[0] === article.image_url.split('?')[0])) {
                        firstImg.remove();
                        content = doc.body.innerHTML;
                    }
                } catch (e) {
                    console.warn("Failed to parse and remove duplicate image.", e);
                }
            }

            content = content.replace(/(\[…\]|&hellip;|\.\.\.)\s*$/g, '');
            const isYouTube = article.link && (article.link.includes('youtube.com') || article.link.includes('youtu.be'));

            if (isYouTube) {
                content = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const urlRegex = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\bwww\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])|(\b[A-Z0-9-]{2,}\.(ai|com|org|net|edu|gov|io)\b)/ig;
                content = content.replace(urlRegex, (match, httpUrl, wwwUrl, domainUrl) => {
                    let url = match;
                    if (wwwUrl || domainUrl) {
                        url = 'http://' + match;
                    }
                    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${match}</a>`;
                });
                const hashtagRegex = /#([\p{L}\p{N}_]+)/gu;
                content = content.replace(hashtagRegex, '<a href="https://www.youtube.com/hashtag/$1" target="_blank" rel="noopener noreferrer">#$1</a>');
                content = content.replace(/\n/g, '<br>');
            }

            return content;
        },

        // --- Data Fetching & Modification ---
        async fetchData() {
            try {
                const response = await fetch('/api/data');
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                this.appData = await response.json();
                
                this.appData.categories = this.appData.categories || [];
                this.appData.feeds = this.appData.feeds || [];
                this.appData.articles = this.appData.articles || [];
                this.appData.removedFeeds = this.appData.removedFeeds || [];
                this.appData.customStreams = this.appData.customStreams || [];
                this.appData.customStreamFeedLinks = this.appData.customStreamFeedLinks || [];
                this.appData.removedStreams = this.appData.removedStreams || [];

                if (!this.currentTitle || this.currentTitle === 'All Feeds') {
                    this.setView('all');
                }
                
            } catch (e) {
                console.error('Error fetching data:', e);
                this.appData = { categories: [], feeds: [], articles: [], removedFeeds: [], customStreams: [], customStreamFeedLinks: [], removedStreams: [] };
            }
        },
        
        async addFeed() {
            if (!this.newFeedUrl || !this.newFeedUrl.trim()) { this.feedError = 'Please enter a URL.'; return; }
            this.feedError = '';
            try {
                // We removed the 'new URL(this.newFeedUrl);' check
                // to allow schemeless URLs like 'cincyjungle.com'
                // The backend will handle validation and adding 'https://'
                const response = await fetch('/api/add_feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: this.newFeedUrl.trim() }) });
                
                const result = await response.json();
                
                // Now, the 'feedError' will be set by the *backend's* response
                if (!response.ok) { 
                    this.feedError = result.error || 'Failed to add feed'; 
                    throw new Error(this.feedError); 
                }
                
                this.newFeedUrl = '';
                await this.fetchData();
            } catch (e) {
                // Error is already set, just log the error object
                console.error('Error adding feed:', e);
            }
        },
        
        async addCategory() {
            if (!this.newCategoryName || !this.newCategoryName.trim()) { this.categoryError = 'Please enter a name.'; return; }
            this.categoryError = '';
            try {
                const response = await fetch('/api/add_category', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: this.newCategoryName.trim() }) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Failed to add category');
                this.newCategoryName = '';
                await this.fetchData();
                if (result.id && !this.openCategoryIDs.includes(result.id)) {
                    this.openCategoryIDs.push(result.id);
                }
            } catch (e) { this.categoryError = e.message; console.error('Error adding category:', e); }
        },
        
        async addCustomStream() {
            if (!this.newCustomStreamName || !this.newCustomStreamName.trim()) { this.customStreamError = 'Please enter a name.'; return; }
            this.customStreamError = '';
            try {
                const response = await fetch('/api/add_custom_stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: this.newCustomStreamName.trim() }) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Failed to add stream');
                this.newCustomStreamName = '';
                await this.fetchData();
                if (result.id && !this.openStreamIDs.includes(result.id)) {
                    this.openStreamIDs.push(result.id);
                }
            } catch (e) { this.customStreamError = e.message; console.error('Error adding stream:', e); }
        },
        
        async refreshAllFeeds(isQuiet = false) {
            if (this.isRefreshing) return;
            if (!isQuiet) this.isRefreshing = true;
            try {
                const response = await fetch('/api/refresh_all_feeds', { method: 'POST' });
                await this.fetchData();
                if (!response.ok) {
                    const result = await response.json();
                    console.warn('Refresh endpoint reported errors:', result.errors || 'Unknown error');
                }
            } catch (e) { console.error('Error refreshing feeds:', e); }
            finally { if (!isQuiet) this.isRefreshing = false; }
        },
        
        async toggleFavorite(article) {
            const originalState = article.is_favorite;
            article.is_favorite = !article.is_favorite;
            try {
                const response = await fetch(`/api/article/${article.id}/favorite`, { method: 'POST' });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error);
                article.is_favorite = result.is_favorite;
            } catch (e) { article.is_favorite = originalState; console.error('Favorite toggle failed:', e); }
        },
        
        async toggleBookmark(article) {
            const originalState = article.is_read_later;
            article.is_read_later = !article.is_read_later;
            try {
                const response = await fetch(`/api/article/${article.id}/bookmark`, { method: 'POST' });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error);
                article.is_read_later = result.is_read_later;
            } catch(e) { article.is_read_later = originalState; console.error('Bookmark toggle failed:', e); }
        },
        
        shareArticle(article) {
            if (!navigator.clipboard) { alert('Clipboard API not available.'); return; }
            navigator.clipboard.writeText(article.link).then(() => {
                this.copiedArticleId = article.id;
                setTimeout(() => { this.copiedArticleId = null; }, 2000);
            }).catch(err => {
                console.error('Failed to copy link: ', err);
                alert('Failed to copy link.');
            });
        },

        // --- Feed/Stream/Category Deletion Logic ---
        async softDeleteFeed(feedId) {
            try {
                const response = await fetch(`/api/feed/${feedId}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Failed to remove feed');
                if (this.currentView.type === 'feed' && this.currentView.id === feedId) {
                    this.setView('all');
                }
                await this.fetchData();
            } catch (e) { console.error('Error soft deleting feed:', e.message); }
        },
        
        async restoreFeed(feedId) {
            try {
                const response = await fetch(`/api/feed/${feedId}/restore`, { method: 'POST' });
                if (!response.ok) throw new Error('Failed to restore feed');
                await this.fetchData();
            } catch (e) { console.error('Error restoring feed:', e.message); }
        },
        
        confirmPermanentDeleteFeed(feedId) {
            const feedTitle = this.getFeedTitle(feedId);
            if (confirm(`Permanently delete feed "${feedTitle}" and all its articles? This cannot be undone.`)) {
                this.permanentlyDeleteFeed(feedId);
            }
        },
        
        async permanentlyDeleteFeed(feedId) {
            try {
                const response = await fetch(`/api/feed/${feedId}/permanent`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Failed to permanently delete feed');
                await this.fetchData();
            } catch (e) { console.error('Error permanently deleting feed:', e.message); }
        },

        async softDeleteStream(streamId) {
            try {
                const response = await fetch(`/api/custom_stream/${streamId}`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Failed to remove stream');
                if (this.currentView.type === 'custom_stream' && this.currentView.id === streamId) {
                    this.setView('all');
                }
                await this.fetchData();
            } catch (e) { console.error('Error soft deleting stream:', e.message); }
        },
        
        async restoreStream(streamId) {
            try {
                const response = await fetch(`/api/custom_stream/${streamId}/restore`, { method: 'POST' });
                if (!response.ok) throw new Error('Failed to restore stream');
                await this.fetchData();
            } catch (e) { console.error('Error restoring stream:', e.message); }
        },
        
        confirmPermanentDeleteStream(streamId) {
            const stream = this.appData.removedStreams.find(s => s.id === streamId) || this.appData.customStreams.find(s => s.id === streamId);
            const streamName = stream ? stream.name : 'this stream';
            if (confirm(`Permanently delete stream "${streamName}"? Feeds will NOT be deleted, just unlinked.`)) {
                this.permanentlyDeleteStream(streamId);
            }
        },
        
        async permanentlyDeleteStream(streamId) {
            try {
                const response = await fetch(`/api/custom_stream/${streamId}/permanent`, { method: 'DELETE' });
                if (!response.ok) throw new Error('Failed to permanently delete stream');
                await this.fetchData();
            } catch (e) { console.error('Error permanently deleting stream:', e.message); }
        },
        
        async removeFeedFromStream(streamId, feedId) {
            try {
                const response = await fetch(`/api/custom_stream/${streamId}/feed/${feedId}`, { method: 'DELETE'});
                if (!response.ok) throw new Error('Failed to remove feed from stream');
                await this.fetchData();
            } catch (e) { console.error('Error removing feed from stream:', e.message); }
        },

        async renameCategory(categoryId, oldName) {
            const newName = prompt('Enter new category name:', oldName);
            if (!newName || !newName.trim() || newName.trim() === oldName) return;
            try {
                const response = await fetch(`/api/category/${categoryId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Failed to rename category');
                await this.fetchData();
            } catch (e) { alert(`Error: ${e.message}`); console.error('Error renaming category:', e); }
        },
        
        async deleteCategory(categoryId) {
            const catName = this.getCategoryName(categoryId);
            if (catName === 'Uncategorized') { alert("Cannot delete the 'Uncategorized' category."); return; }
            if (confirm(`Are you sure you want to delete the category "${catName}"?\nFeeds inside will be moved to "Uncategorized".`)) {
                try {
                    const response = await fetch(`/api/category/${categoryId}`, { method: 'DELETE' });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || 'Failed to delete category');
                    if (this.currentView.type === 'category' && this.currentView.id === categoryId) { this.setView('all'); }
                    await this.fetchData();
                } catch (e) { alert(`Error: ${e.message}`); console.error('Error deleting category:', e); }
            }
        },

        // --- Drag & Drop ---
        dragStartFeed(feedId, event) {
            if (event.target.closest('a[draggable="true"]')) {
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move';
                }
                this.draggingFeedId = feedId;
                event.target.closest('a').classList.add('dragging');
            } else {
                event.preventDefault();
            }
        },
        
        dragEndAll() {
            if (this.draggingFeedId) {
                document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
            }
            this.draggingFeedId = null;
            this.dragOverCategoryId = null;
            this.dragOverStreamId = null;
            this.touchDragging = false;
            if (this.pressTimer) {
                clearTimeout(this.pressTimer);
                this.pressTimer = null;
            }
            this.touchStartEvent = null;
        },

        handleTouchStart(feedId, event) {
            if (this.draggingFeedId || !event.target.closest('a[draggable="true"]')) return;
            
            this.touchStartX = event.touches[0].clientX;
            this.touchStartY = event.touches[0].clientY;
            this.touchStartEvent = event;
            
            if (this.pressTimer) clearTimeout(this.pressTimer);

            this.pressTimer = setTimeout(() => {
                if (this.touchStartEvent) {
                    this.touchStartEvent.preventDefault();
                    this.draggingFeedId = feedId;
                    this.touchDragging = true;
                    event.target.closest('a').classList.add('dragging');
                    this.pressTimer = null;
                    this.touchStartEvent = null;
                }
            }, 350);
        },
        
        handleTouchMove(event) {
            if (this.pressTimer) {
                const touch = event.touches[0];
                const deltaX = Math.abs(touch.clientX - this.touchStartX);
                const deltaY = Math.abs(touch.clientY - this.touchStartY);
                if (deltaX > 10 || deltaY > 10) {
                    clearTimeout(this.pressTimer);
                    this.pressTimer = null;
                    this.touchStartEvent = null;
                }
            }

            if (!this.touchDragging || !this.draggingFeedId) return;

            event.preventDefault();

            const touch = event.touches[0];
            const elementUnderTouch = document.elementFromPoint(touch.clientX, touch.clientY);

            if (!elementUnderTouch) {
                this.dragOverCategoryId = null;
                this.dragOverStreamId = null;
                return;
            }

            const categoryTarget = elementUnderTouch.closest('[data-category-id]');
            const streamTarget = elementUnderTouch.closest('[data-stream-id]');

            this.dragOverCategoryId = categoryTarget ? parseInt(categoryTarget.dataset.categoryId) : null;
            this.dragOverStreamId = streamTarget ? parseInt(streamTarget.dataset.streamId) : null;

            if (this.dragOverCategoryId && this.dragOverStreamId) {
                this.dragOverCategoryId = null; // Prioritize stream
            }
        },
        
        handleTouchEnd(event) {
            if (this.pressTimer) {
                clearTimeout(this.pressTimer);
                this.pressTimer = null;
            }
            this.touchStartEvent = null;

            if (!this.touchDragging || !this.draggingFeedId) {
                this.dragEndAll();
                return;
            }

            let dropped = false;
            if (this.dragOverCategoryId) {
                this.dropFeed(this.dragOverCategoryId);
                dropped = true;
            } else if (this.dragOverStreamId) {
                this.dropFeedOnStream(this.dragOverStreamId);
                dropped = true;
            }

            if (!dropped) {
                this.dragEndAll();
            }
        },

        async dropFeed(targetCategoryId) {
            if (!this.draggingFeedId) { this.dragEndAll(); return; }
            const feed = this.appData.feeds.find(f => f.id === this.draggingFeedId);
            if (!feed || feed.category_id === targetCategoryId) { this.dragEndAll(); return; }

            try {
                const response = await fetch('/api/move_feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feed_id: this.draggingFeedId, new_category_id: targetCategoryId }) });
                if (!response.ok) throw new Error('API failed to move feed');
                if (!this.openCategoryIDs.includes(targetCategoryId)) {
                    this.openCategoryIDs.push(targetCategoryId);
                }
                await this.fetchData();
            } catch (e) {
                console.error('Error moving feed:', e);
                await this.fetchData();
            } finally {
                this.dragEndAll();
            }
        },
        
        async dropFeedOnStream(streamId) {
            if (!this.draggingFeedId) { this.dragEndAll(); return; }
            const exists = this.appData.customStreamFeedLinks.some(l => l.custom_stream_id === streamId && l.feed_id === this.draggingFeedId);
            if (exists) { this.dragEndAll(); return; }

            try {
                const response = await fetch('/api/custom_stream/add_feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ custom_stream_id: streamId, feed_id: this.draggingFeedId }) });
                if (!response.ok) throw new Error('API failed to link feed');
                if (!this.openStreamIDs.includes(streamId)) {
                    this.openStreamIDs.push(streamId);
                }
                await this.fetchData();
            } catch (e) {
                console.error('Error linking feed to stream:', e);
                await this.fetchData();
            } finally {
                this.dragEndAll();
            }
        },
    };
}

// --- CORRECTED ALPINE INITIALIZATION ---
// This tells Alpine to register your 'rssApp' function as a component.
document.addEventListener('alpine:init', () => {
    Alpine.data('rssApp', rssApp);
});
