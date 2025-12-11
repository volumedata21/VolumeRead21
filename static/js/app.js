// --- Helper for seeking YouTube embeds ---
// Must be global to work with onclick attributes generated in HTML strings
window.seekToTimestamp = function(seconds) {
    const iframe = document.getElementById('yt-player');
    if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(JSON.stringify({
            event: 'command',
            func: 'seekTo',
            args: [seconds, true]
        }), '*');
    }
};

document.addEventListener('alpine:init', () => {
    Alpine.data('rssApp', () => ({
        // --- Core App State ---
        appData: {
            categories: [],
            feeds: [],
            customStreams: [],
            removedFeeds: [],
            removedStreams: [],
            customStreamFeedLinks: [],
        },
        articles: [],
        currentView: { type: 'all', id: null, title: 'All Feeds' },
        

        // --- Article Loading State ---
        currentPage: 1,
        totalPages: 1,
        hasNextPage: false,
        isLoadingArticles: false,
        
        // --- UI State ---
        isMobileMenuOpen: false,
        isModalOpen: false,
        modalArticle: null,
        modalEmbedHtml: null, 
        activeArticleIndex: -1, 
        isRefreshing: false,
        copiedArticleId: null,
        
        // --- Sidebar State ---
        openCategoryIDs: [],
        openStreamIDs: [],
        isFeedsSectionCollapsed: false,
        isStreamsSectionCollapsed: false,

        // --- Forms & Errors ---
        newFeedUrl: '',
        feedError: '',
        newCustomStreamName: '',
        customStreamError: '',
        newCategoryName: '',
        categoryError: '',
        
        // --- Filtering & Sorting ---
        searchQuery: '',
        sortOrder: 'newest',
        unreadOnly: false,
        
        // --- Drag & Drop State ---
        draggingFeedId: null,
        dragOverCategoryId: null,
        dragOverStreamId: null,

        // --- Bulk Assign State ---
        selectedFeedIds: [], 
        isAssignModalOpen: false,
        assignModalCategoryId: 'none', 
        assignModalStreamIds: [], 

        // --- Edit Modal State ---
        isEditModalOpen: false,
        editModal: { type: null, id: null, currentName: '', url: '', layout_style: 'default' },
        editModalNewName: '',
        editModalError: '',
        editModalExcludeAll: false,
        editModalFeedStates: {},

        // --- Settings/Import/Export State ---
        isSettingsModalOpen: false,
        importStatus: '', 
        importMessage: '',
        
        // --- YouTube API State ---
        ytPlayer: null,
        isYtApiReady: false,

        // --- Init Function ---
        async init() {
            this.loadYouTubeApi(); 
            this.setupKeyboardShortcuts(); // Initialize shortcuts
            this.isRefreshing = true;
            await this.fetchAppData();
            await this.fetchArticles(true); 
            this.isRefreshing = false;
            
            // Auto-refresh every 15 minutes
            setInterval(() => this.refreshAllFeeds(true), 15 * 60 * 1000);
        },

        // --- Keyboard Shortcuts (J/K Navigation) ---
        setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                // Ignore if typing in an input
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

                const key = e.key.toLowerCase();

                // Navigation (J = Next, K = Prev)
                if (key === 'j' || key === 'k') {
                    const articles = this.filteredArticles;
                    if (articles.length === 0) return;

                    let newIndex = -1;

                    if (key === 'j') {
                        newIndex = this.activeArticleIndex + 1;
                    } else if (key === 'k') {
                        newIndex = this.activeArticleIndex - 1;
                    }

                    // Bounds check
                    if (newIndex >= 0 && newIndex < articles.length) {
                        this.activeArticleIndex = newIndex;
                        const nextArticle = articles[newIndex];
                        
                        // If modal is open, switch content. If closed, open it.
                        // Note: openModal now triggers markAsRead automatically
                        this.openModal(nextArticle); 
                        
                        // Optional: Scroll background list to keep item in view
                        // document.getElementById('article-card-' + nextArticle.id)?.scrollIntoView({block: 'center', behavior: 'smooth'});
                    }
                }

                // Actions for the ACTIVE article (modal open)
                if (this.isModalOpen && this.modalArticle) {
                    if (key === 'f') {
                        this.toggleFavorite(this.modalArticle);
                    }
                    if (key === 'b') { // B for Bookmark/Read Later
                        this.toggleBookmark(this.modalArticle);
                    }
                    if (key === 'v') { // V for View Original
                         window.open(this.modalArticle.link, '_blank');
                    }
                }
            });
        },

        // --- YouTube API Loader ---
        loadYouTubeApi() {
            if (window.YT) {
                this.isYtApiReady = true;
                return;
            }
            const tag = document.createElement('script');
            tag.src = "https://www.youtube.com/iframe_api";
            const firstScriptTag = document.getElementsByTagName('script')[0];
            firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            
            window.onYouTubeIframeAPIReady = () => {
                this.isYtApiReady = true;
            };
        },

        // --- Smart Image Error Handler ---
        handleImageError(event) {
            const img = event.target;
            const src = img.src;
            if (src.includes('maxresdefault.jpg')) {
                img.src = src.replace('maxresdefault.jpg', 'hqdefault.jpg');
            } else {
                img.style.display = 'none';
                if (img.nextElementSibling) {
                    img.nextElementSibling.style.display = 'flex';
                }
            }
        },

        // --- Infinite Scroll Handler ---
        handleScroll(event) {
            const el = event.target;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
                this.loadMoreArticles();
            }
        },
        
        loadMoreArticles() {
            this.fetchArticles(false); 
        },

        // --- API: Data Fetching ---
        async fetchAppData() {
            try {
                const response = await fetch('/api/data');
                if (!response.ok) throw new Error('Failed to fetch app data');
                const data = await response.json();
                this.appData = {
                    categories: data.categories || [],
                    feeds: data.feeds || [],
                    customStreams: data.customStreams || [],
                    removedFeeds: data.removedFeeds || [],
                    removedStreams: data.removedStreams || [],
                    customStreamFeedLinks: data.customStreamFeedLinks || [],
                };
            } catch (error) {
                console.error('Error fetching app data:', error);
            }
        },
        
        async fetchArticles(isNewQuery = false) {
            if (isNewQuery) {
                this.currentPage = 1;
                this.articles = [];
                this.hasNextPage = false;
            }

            if (this.isLoadingArticles || (this.currentPage > 1 && !this.hasNextPage)) {
                return; 
            }

            this.isLoadingArticles = true;

            let url = `/api/articles?page=${this.currentPage}`;
            
            // 1. Append Unread Filter
            if (this.unreadOnly) {
                url += '&unread_only=true';
            }

            // 2. Append View Type (Always required)
            url += `&view_type=${this.currentView.type}`;

            // 3. Append View ID (If specific view)
            if (this.currentView.id) {
                url += `&view_id=${this.currentView.id}`;
            }

            // 4. Append Author (If author view)
            if (this.currentView.type === 'author' && this.currentView.title) {
                 url += `&author_name=${encodeURIComponent(this.currentView.title)}`;
            }

            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error('Failed to fetch articles');
                const data = await response.json();
                
                this.articles = this.articles.concat(data.articles);
                this.totalPages = data.total_pages;
                this.hasNextPage = data.has_next;
                
                if (data.is_reddit_source) {
                    this.currentView.is_reddit_source = true;
                }

                this.currentPage += 1; 
                
            } catch (error) {
                console.error('Error fetching articles:', error);
            } finally {
                this.isLoadingArticles = false;
            }
        },

        async refreshAllFeeds(isAutoRefresh = false) {
            if (this.isRefreshing) return;
            this.isRefreshing = true;
            try {
                await fetch('/api/refresh_all_feeds', { method: 'POST' });
                await this.fetchAppData();
                await this.fetchArticles(true); 
            } catch (error) {
                console.error('Error refreshing feeds:', error);
            } finally {
                this.isRefreshing = false;
            }
        },
        
        // --- Computed Properties ---
        get currentTitle() {
            if (this.currentView.type === 'all') return 'All Feeds';
            if (this.currentView.type === 'favorites') return 'Favorites';
            if (this.currentView.type === 'readLater') return 'Read Later';
            if (this.currentView.type === 'videos') return 'Videos';
            if (this.currentView.type === 'threads') return 'Threads';
            if (this.currentView.type === 'sites') return 'Sites';
            
            if (this.currentView.type === 'feed') {
                const feed = this.appData.feeds.find(f => f.id === this.currentView.id);
                return feed ? feed.title : 'Feed';
            }
            if (this.currentView.type === 'category') {
                const cat = this.appData.categories.find(c => c.id === this.currentView.id);
                return cat ? cat.name : 'Category';
            }
            if (this.currentView.type === 'custom_stream') {
                const stream = this.appData.customStreams.find(s => s.id === this.currentView.id);
                return stream ? stream.name : 'Stream';
            }
            if (this.currentView.type === 'author') {
                return this.currentView.title || 'Author';
            }
            return 'VolumeRead21';
        },
        
        get filteredArticles() {
            let articles = [...this.articles];

            if (this.searchQuery.trim() !== '') {
                const query = this.searchQuery.toLowerCase();
                articles = articles.filter(a =>
                    a.title.toLowerCase().includes(query) ||
                    (a.summary && a.summary.toLowerCase().includes(query)) ||
                    a.feed_title.toLowerCase().includes(query) ||
                    a.author.toLowerCase().includes(query)
                );
            }

            articles.sort((a, b) => {
                const dateA = new Date(a.published);
                const dateB = new Date(b.published);
                return this.sortOrder === 'newest' ? dateB - dateA : dateA - dateB;
            });

            return articles;
        },
        
        getEmptyMessage() {
            if (this.isLoadingArticles && this.articles.length === 0) return 'Loading articles...';
            if (this.searchQuery) return 'No articles match your search.';
            if (this.appData.feeds.length === 0) return 'Add a feed to get started.';
            return 'No articles found for this view.';
        },
        
        // --- View & Navigation ---
        setView(type, id = null, title = null) {
            let assignedStyle = null;
            if (type === 'feed') {
                const f = this.appData.feeds.find(x => x.id === id);
                if (f) assignedStyle = f.layout_style;
            } else if (type === 'category') {
                const c = this.appData.categories.find(x => x.id === id);
                if (c) assignedStyle = c.layout_style;
            } else if (type === 'custom_stream') {
                const s = this.appData.customStreams.find(x => x.id === id);
                if (s) assignedStyle = s.layout_style;
            }

            this.currentView = { 
                type, 
                id, 
                title, 
                is_reddit_source: (type === 'threads'),
                assigned_style: assignedStyle 
            };
            
            this.searchQuery = '';
            this.fetchArticles(true);
            this.isMobileMenuOpen = false;
        },

        toggleUnreadOnly() {
            this.unreadOnly = !this.unreadOnly;
            this.fetchArticles(true); // true = reset to page 1
        },
        
        get layoutMode() {
            if (this.currentView.assigned_style && this.currentView.assigned_style !== 'default') {
                return this.currentView.assigned_style;
            }
            if (['all', 'videos', 'threads', 'sites', 'favorites', 'readLater'].includes(this.currentView.type)) {
                const localStyle = localStorage.getItem('style_' + this.currentView.type);
                if (localStyle && localStyle !== 'default') {
                    return localStyle;
                }
            }
            if (this.currentView.type === 'threads' || this.currentView.is_reddit_source) {
                return 'threads';
            }
            if (this.currentView.type === 'videos') {
                return 'videos';
            }
            return 'standard'; 
        },

        // --- Sidebar Toggles ---
        toggleCategory(id) {
            this.openCategoryIDs = this.toggleArrayItem(this.openCategoryIDs, id);
        },
        toggleStream(id) {
            this.openStreamIDs = this.toggleArrayItem(this.openStreamIDs, id);
        },
        toggleArrayItem(arr, item) {
            const index = arr.indexOf(item);
            if (index > -1) {
                return [...arr.slice(0, index), ...arr.slice(index + 1)];
            } else {
                return [...arr, item];
            }
        },
        
        // --- Sidebar Helpers ---
        getFeedsInCategory(categoryId) {
            return this.appData.feeds.filter(f => f.category_id === categoryId);
        },
        getFeedsInStream(streamId) {
            const feedIds = this.appData.customStreamFeedLinks
                .filter(link => link.custom_stream_id === streamId)
                .map(link => link.feed_id);
            return this.appData.feeds.filter(feed => feedIds.includes(feed.id));
        },
        
        // --- Drag & Drop ---
        dragStartFeed(feedId, event) {
            if (this.selectedFeedIds.length > 0) {
                event.preventDefault();
                return;
            }
            this.draggingFeedId = feedId;
            event.dataTransfer.effectAllowed = 'move';
        },
        dragEndAll() {
            this.draggingFeedId = null;
            this.dragOverCategoryId = null;
            this.dragOverStreamId = null;
        },
        async dropFeed(categoryId) {
            if (!this.draggingFeedId || !categoryId) return;
            await this.apiPost('/api/move_feed', { feed_id: this.draggingFeedId, new_category_id: categoryId });
            this.dragEndAll();
        },
        async dropFeedOnStream(streamId) {
            if (!this.draggingFeedId || !streamId) return;
            await this.apiPost('/api/custom_stream/add_feed', { custom_stream_id: streamId, feed_id: this.draggingFeedId });
            this.dragEndAll();
        },
        handleTouchStart(feedId, event) {
            if (this.selectedFeedIds.length > 0) {
                event.preventDefault();
                return;
            }
            this.draggingFeedId = feedId;
        },

        // --- Bulk Feed Assignment ---
        clearSelection() {
            this.selectedFeedIds = [];
        },
        openAssignModal() {
            this.assignModalCategoryId = 'none';
            this.assignModalStreamIds = [];
            this.isAssignModalOpen = true;
        },
        async assignFeeds() {
            if (this.selectedFeedIds.length === 0) return;
            const payload = {
                feed_ids: this.selectedFeedIds,
                category_id: this.assignModalCategoryId === 'none' ? null : parseInt(this.assignModalCategoryId),
                stream_ids: this.assignModalStreamIds.map(id => parseInt(id))
            };
            const data = await this.apiPost('/api/assign_feeds_bulk', payload);
            if (data.error) {
                console.error("Error assigning feeds:", data.error);
                alert("Error assigning feeds: " + data.error); 
            } else {
                this.isAssignModalOpen = false;
                this.clearSelection();
            }
        },

        // --- View Settings ---
        openViewSettings() {
            const type = this.currentView.type;
            const id = this.currentView.id;
            const title = this.currentTitle;

            if (['all', 'videos', 'threads', 'sites', 'favorites', 'readLater'].includes(type)) {
                this.editModal = {
                    type: 'global', 
                    id: type,       
                    currentName: title,
                    url: '',
                    layout_style: localStorage.getItem('style_' + type) || 'default'
                };
                this.editModalNewName = title;
                this.editModalError = '';
                this.editModalExcludeAll = false; 
                this.isEditModalOpen = true;
            } else {
                this.openEditModal(type, id, title);
            }
        },

        // --- Edit Modal ---
        openEditModal(type, id, currentName) {
            this.editModal = { type, id, currentName, url: '', layout_style: 'default' };
            this.editModalNewName = currentName;
            this.editModalError = '';
            this.editModalFeedStates = {};
            this.editModalExcludeAll = false;

            if (type === 'feed') {
                const feed = this.appData.feeds.find(f => f.id === id);
                if (feed) {
                    this.editModalFeedStates[id] = feed.exclude_from_all;
                    this.editModal.url = feed.url;
                    this.editModal.layout_style = feed.layout_style || 'default';
                }
            } else if (type === 'category') {
                const cat = this.appData.categories.find(c => c.id === id);
                if (cat) this.editModal.layout_style = cat.layout_style || 'default';
                const feeds = this.getFeedsInCategory(id);
                let allExcluded = feeds.length > 0;
                for (const feed of feeds) {
                    this.editModalFeedStates[feed.id] = feed.exclude_from_all;
                    if (!feed.exclude_from_all) allExcluded = false;
                }
                this.editModalExcludeAll = allExcluded;
            } else if (type === 'stream') { 
                const stream = this.appData.customStreams.find(s => s.id === id);
                if (stream) this.editModal.layout_style = stream.layout_style || 'default';
            }

            this.isEditModalOpen = true;
        },

        toggleExcludeAllFeeds(isChecked) {
            for (const feedId in this.editModalFeedStates) {
                this.editModalFeedStates[feedId] = isChecked;
            }
        },

        updateExcludeAllState() {
            if (this.editModal.type !== 'category') return;
            const allChecked = Object.values(this.editModalFeedStates).every(Boolean);
            this.editModalExcludeAll = allChecked;
        },

        async submitEditModal() {
            this.editModalError = '';
            const { type, id } = this.editModal;
            
            if (type === 'global') {
                localStorage.setItem('style_' + id, this.editModal.layout_style);
                this.isEditModalOpen = false;
                this.currentView = { ...this.currentView }; 
                return;
            }

            const newName = this.editModalNewName.trim();
            let url = '';
            let payload = { name: newName, layout_style: this.editModal.layout_style };

            if (type === 'feed') {
                url = `/api/feed/${id}`;
                payload.exclude_from_all = this.editModalFeedStates[id];
            } else if (type === 'category') {
                url = `/api/category/${id}`;
                payload.feed_exclusion_states = this.editModalFeedStates;
            } else if (type === 'stream') {
                 url = `/api/custom_stream/${id}`;
            } else {
                return;
            }

            const data = await this.apiPut(url, payload);

            if (data.error) {
                this.editModalError = data.error;
            } else {
                this.isEditModalOpen = false;
                if (this.currentView.type === (type === 'stream' ? 'custom_stream' : type) && this.currentView.id === id) {
                     this.setView(this.currentView.type, id, newName);
                } else {
                     await this.fetchAppData();
                }
            }
        },

        // --- Settings & Import/Export ---
        openSettings() {
            this.isSettingsModalOpen = true;
            this.importStatus = '';
            this.importMessage = '';
        },
        
        exportFeeds() {
            window.location.href = '/api/export_opml';
        },
        
        async importFeeds(event) {
            const file = event.target.files[0];
            if (!file) return;
            
            this.importStatus = 'uploading';
            this.importMessage = 'Importing feeds...';
            
            const formData = new FormData();
            formData.append('file', file);
            
            try {
                const response = await fetch('/api/import_opml', { method: 'POST', body: formData });
                const data = await response.json();
                
                if (response.ok) {
                    this.importStatus = 'success';
                    this.importMessage = data.message;
                    await this.fetchAppData();
                    this.refreshAllFeeds(true);
                } else {
                    this.importStatus = 'error';
                    this.importMessage = data.error || 'Import failed';
                }
            } catch (e) {
                this.importStatus = 'error';
                this.importMessage = 'Network error during import';
            }
            event.target.value = '';
        },

        // --- API: CRUD Operations ---
        async addFeed() {
            this.feedError = '';
            if (!this.newFeedUrl) return;
            const data = await this.apiPost('/api/add_feed', { url: this.newFeedUrl });
            if (data.error) {
                this.feedError = data.error;
            } else {
                this.newFeedUrl = '';
                await this.fetchAppData();
                await this.fetchArticles(true);
            }
        },
        async softDeleteFeed(feedId) {
            if (!confirm('Are you sure you want to remove this feed?')) return;
            await this.apiDelete(`/api/feed/${feedId}`);
        },
        async restoreFeed(feedId) {
            await this.apiPost(`/api/feed/${feedId}/restore`);
        },
        async confirmPermanentDeleteFeed(feedId) {
            if (!confirm('PERMANENTLY DELETE? This cannot be undone.')) return;
            await this.apiDelete(`/api/feed/${feedId}/permanent`);
        },
        renameFeed(feedId, currentName) {
            this.openEditModal('feed', feedId, currentName);
        },
        async addCategory() {
            this.categoryError = '';
            if (!this.newCategoryName) return;
            const data = await this.apiPost('/api/add_category', { name: this.newCategoryName });
            if (data.error) {
                this.categoryError = data.error;
            } else {
                this.newCategoryName = '';
            }
        },
        async deleteCategory(categoryId) {
            if (!confirm('Delete this category? Feeds will be moved to Uncategorized.')) return;
            await this.apiDelete(`/api/category/${categoryId}`);
        },
        renameCategory(categoryId, currentName) {
            this.openEditModal('category', categoryId, currentName);
        },
        async addCustomStream() {
            this.customStreamError = '';
            if (!this.newCustomStreamName) return;
            const data = await this.apiPost('/api/add_custom_stream', { name: this.newCustomStreamName });
            if (data.error) {
                this.customStreamError = data.error;
            } else {
                this.newCustomStreamName = '';
            }
        },
        async softDeleteStream(streamId) {
            if (!confirm('Are you sure you want to remove this stream?')) return;
            await this.apiDelete(`/api/custom_stream/${streamId}`);
        },
        async restoreStream(streamId) {
            await this.apiPost(`/api/custom_stream/${streamId}/restore`);
        },
        async confirmPermanentDeleteStream(streamId) {
            if (!confirm('PERMANENTLY DELETE? This cannot be undone.')) return;
            await this.apiDelete(`/api/custom_stream/${streamId}/permanent`);
        },
        async removeFeedFromStream(streamId, feedId) {
            await this.apiDelete(`/api/custom_stream/${streamId}/feed/${feedId}`);
        },
        async toggleFavorite(article) {
            const response = await this.apiPost(`/api/article/${article.id}/favorite`);
            if (response && typeof response.is_favorite !== 'undefined') {
                article.is_favorite = response.is_favorite;
                if (this.currentView.type === 'favorites') {
                    await this.fetchArticles(true);
                }
            }
        },
        async toggleBookmark(article) {
            const response = await this.apiPost(`/api/article/${article.id}/bookmark`);
            if (response && typeof response.is_read_later !== 'undefined') {
                article.is_read_later = response.is_read_later;
                if (this.currentView.type === 'readLater') {
                    await this.fetchArticles(true);
                }
            }
        },

        // --- NEW: Read/Unread Logic ---
        async markAsRead(article) {
            if (article.is_read) return;
            article.is_read = true; // Optimistic UI update
            await this.apiPost(`/api/article/${article.id}/mark_read`);
        },

        async markAllRead() {
            if (!confirm('Mark all visible articles as read?')) return;
            
            const payload = {
                view_type: this.currentView.type,
                view_id: this.currentView.id
            };
            
            await this.apiPost('/api/mark_all_read', payload);
            
            // Update local state to reflect change immediately
            this.articles.forEach(a => a.is_read = true);
        },
        
        // --- Modal & Autoplay ---
        openModal(article) {
            // *** NEW: Destroy previous player instance if it exists ***
            if (this.ytPlayer) {
                try { this.ytPlayer.destroy(); } catch(e) {}
                this.ytPlayer = null;
            }

            // *** NEW: Mark as read when opening ***
            this.markAsRead(article); 

            // 1. Track the current index for "Next" logic
            const currentList = this.filteredArticles;
            this.activeArticleIndex = currentList.findIndex(a => a.id === article.id);

            this.modalArticle = article;
            this.isModalOpen = true;
            
            this.modalEmbedHtml = this.getYouTubeEmbed(article.link) || 
                                  this.getTikTokEmbed(article.link) || 
                                  this.getVimeoEmbed(article.link) || 
                                  this.getDailymotionEmbed(article.link) || 
                                  this.getRedgifsEmbed(article.full_content) || 
                                  this.getImgurEmbed(article.full_content) || 
                                  this.getStreamableEmbed(article.full_content) || 
                                  this.getGfycatEmbed(article.full_content) ||
                                  this.getTwitchClipEmbed(article.full_content) || 
                                  this.getOtherGifEmbed(article.full_content);

            this.$nextTick(() => {
                if (this.$refs.modalContent) {
                    this.$refs.modalContent.scrollTop = 0;
                }
                // *** NEW: Initialize watcher for autoplay ***
                this.initVideoWatcher();
            });
        },

        closeModal() {
            this.isModalOpen = false;
            setTimeout(() => {
                this.modalArticle = null;
                this.modalEmbedHtml = null; 
                // Destroy YT player if exists to stop audio
                if (this.ytPlayer) {
                    try { this.ytPlayer.destroy(); } catch(e) {}
                    this.ytPlayer = null;
                }
            }, 200);
        },

        // *** NEW: Autoplay Logic ***
        initVideoWatcher() {
            // Case A: YouTube Iframe
            const ytIframe = document.getElementById('yt-player');
            if (ytIframe) {
                // *** FIX: Retry logic if API is not ready yet ***
                if (!window.YT || !this.isYtApiReady) {
                    setTimeout(() => this.initVideoWatcher(), 100);
                    return;
                }

                // Initialize YT Player
                // Check if player already exists to avoid double-init
                if (this.ytPlayer) return;
                
                try {
                    this.ytPlayer = new YT.Player('yt-player', {
                        events: {
                            'onStateChange': (event) => {
                                // State 0 = ENDED
                                if (event.data === 0) {
                                    this.playNext();
                                }
                            }
                        }
                    });
                } catch(e) {
                    console.error("YT Player Init Error", e);
                }
                return;
            }

            // Case B: Native HTML5 Video (Imgur, uploads, etc)
            const nativeVideo = document.querySelector('#modal-content video');
            if (nativeVideo) {
                nativeVideo.addEventListener('ended', () => {
                    this.playNext();
                });
            }
        },

        // *** NEW: Play Next Function (Smart Skip) ***
        playNext() {
            if (this.activeArticleIndex === -1) return;
            
            let nextIndex = this.activeArticleIndex + 1;
            const articles = this.filteredArticles;

            // Loop to find the next autoplayable video
            while (nextIndex < articles.length) {
                const nextArticle = articles[nextIndex];
                
                // We only autoplay YouTube or Native videos (Imgur/MP4) because
                // we can reliably detect when they end.
                // We skip TikTok, Vimeo, Text posts, etc.
                const isYouTube = !!this.getYouTubeEmbed(nextArticle.link);
                const isNative = !!this.getImgurEmbed(nextArticle.full_content);

                if (isYouTube || isNative) {
                    console.log("Autoplaying next:", nextArticle.title);
                    this.openModal(nextArticle);
                    return;
                }
                
                // If not supported, skip to next index
                nextIndex++;
            }

            console.log("End of playlist.");
        },
        
        renderModalContent(article) {
            let content = article.full_content;
            if (!content) {
                content = article.summary || '';
            }
            if (this.modalEmbedHtml && content) {
                 try {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = content;
                    const images = tempDiv.querySelectorAll('img');
                    images.forEach(img => img.remove());
                    const figures = tempDiv.querySelectorAll('figure');
                    figures.forEach(fig => fig.remove());
                    const walk = document.createTreeWalker(tempDiv, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    while (node = walk.nextNode()) {
                        if (node.nodeValue.trim().toLowerCase() === 'tik tok' || node.nodeValue.trim().toLowerCase() === 'tiktok') {
                            node.nodeValue = '';
                        }
                    }
                    content = tempDiv.innerHTML;
                } catch (e) {
                    console.error("Error cleaning modal content:", e);
                }
            }
            if (this.modalEmbedHtml && content) {
                const hasHtmlTags = /<br|<p|<div/i.test(content);
                if (!hasHtmlTags) {
                    const urlRegex = /(https?:\/\/[^\s<"]+)/g;
                    content = content.replace(urlRegex, (url) => {
                        const trailing = url.match(/[.,;!)]+$/);
                        let cleanUrl = url;
                        let suffix = '';
                        if (trailing) {
                            suffix = trailing[0];
                            cleanUrl = url.substring(0, url.length - suffix.length);
                        }
                        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="text-[var(--text-highlight)] hover:underline">${cleanUrl}</a>${suffix}`;
                    });
                    const timestampRegex = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
                    content = content.replace(timestampRegex, (match, h, m, s) => {
                        let seconds = 0;
                        if (h) {
                            seconds = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
                        } else {
                            seconds = parseInt(m) * 60 + parseInt(s);
                        }
                        return `<button onclick="window.seekToTimestamp(${seconds})" class="text-[var(--text-highlight)] hover:underline cursor-pointer">${match}</button>`;
                    });
                    if (content.includes('\n')) {
                        const paragraphs = content.split(/\n\s*\n/);
                        content = paragraphs
                            .map(p => `<p class="mb-4">${p.replace(/\n/g, '<br>')}</p>`)
                            .join('');
                    } else {
                         content = `<p>${content}</p>`;
                    }
                }
            }
            if (article.image_url && !this.modalEmbedHtml) {
                try {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = content;
                    const imgToRemove = tempDiv.querySelector(`img[src="${article.image_url}"]`);
                    if (imgToRemove) {
                        imgToRemove.parentNode.removeChild(imgToRemove);
                        content = tempDiv.innerHTML;
                    }
                } catch (e) {
                    console.error("Error removing duplicate image:", e);
                }
            }
            return content;
        },
        
        // ... Embed Generators ...
        getYouTubeEmbed(link) {
            if (!link) return null;
            const regex = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)([a-zA-Z0-9_-]{11})/;
            const match = link.match(regex);
            
            if (match && match[1]) {
                const videoId = match[1];
                // *** FIX: Added origin parameter (Required for enablejsapi) ***
                const origin = window.location.origin;
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe id="yt-player" src="https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=1&origin=${origin}" 
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                `;
            }
            return null; 
        },

        getTikTokEmbed(link) {
            if (!link) return null;
            const regex = /tiktok\.com\/@[\w.]+\/video\/(\d+)/;
            const match = link.match(regex);

            if (match && match[1]) {
                const videoId = match[1];
                return `
                    <div class="rounded-lg overflow-hidden flex justify-center bg-black">
                        <iframe src="https://www.tiktok.com/embed/v2/${videoId}"
                                style="width: 325px; height: 700px; max-width: 100%;"
                                frameborder="0" 
                                allow="encrypted-media;">
                        </iframe>
                    </div>
                `;
            }
            return null;
        },
        
        getVimeoEmbed(link) {
            if (!link) return null;
            const regex = /vimeo\.com\/(?:.*\/)?(\d+)/;
            const match = link.match(regex);

            if (match && match[1]) {
                const videoId = match[1];
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe src="https://player.vimeo.com/video/${videoId}?autoplay=1" 
                                frameborder="0" 
                                allow="autoplay; fullscreen; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                `;
            }
            return null;
        },

        getDailymotionEmbed(link) {
            if (!link) return null;
            const regex = /dailymotion\.com\/video\/([a-zA-Z0-9]+)/;
            const match = link.match(regex);

            if (match && match[1]) {
                const videoId = match[1];
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe src="https://www.dailymotion.com/embed/video/${videoId}?autoplay=1" 
                                frameborder="0" 
                                allow="autoplay; fullscreen; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                `;
            }
            return null;
        },

        getRedgifsEmbed(htmlContent) {
            if (!htmlContent) return null;
            const regex = /href="(?:https?:\/\/)?(?:www\.)?redgifs\.com\/(?:watch|ifr)\/([a-zA-Z0-9_-]+)"/;
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                const videoId = match[1];
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe src="https://www.redgifs.com/ifr/${videoId}"
                                frameborder="0" 
                                scrolling="no"
                                allowfullscreen
                                style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;">
                        </iframe>
                    </div>
                `;
            }
            return null; 
        },

        getImgurEmbed(htmlContent) {
            if (!htmlContent) return null;
            const regex = /href="(https?:\/\/i\.imgur\.com\/([a-zA-Z0-9]+)\.(mp4|gifv))"/;
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                const videoUrl = match[1].replace('.gifv', '.mp4'); 
                
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <video src="${videoUrl}" 
                               autoplay loop muted playsinline
                               style="width: 100%; height: 100%; position: absolute; top: 0; left: 0; object-fit: contain;">
                        </video>
                    </div>
                `;
            }
            return null; 
        },

        getOtherGifEmbed(htmlContent) {
            if (!htmlContent) return null;
            const regex = /href="([^"]+\.gif)"/;
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                const gifUrl = match[1];
                return `
                    <img class="w-full rounded-lg mb-4" src="${gifUrl}" alt="Embedded GIF">
                `;
            }
            return null; 
        },
        
        getStreamableEmbed(htmlContent) {
            if (!htmlContent) return null;
            const regex = /href="(?:https?:\/\/)?(?:www\.)?streamable\.com\/([a-zA-Z0-9]+)"/;
            const match = htmlContent.match(regex);
            
            if (match && match[1]) {
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe src="https://streamable.com/e/${match[1]}"
                                frameborder="0" 
                                scrolling="no"
                                allowfullscreen
                                style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;">
                        </iframe>
                    </div>
                `;
            }
            return null; 
        },

        getGfycatEmbed(htmlContent) {
            if (!htmlContent) return null;
            const regex = /href="(?:https?:\/\/)?gfycat\.com\/([a-zA-Z0-9]+)"/;
            const match = htmlContent.match(regex);
            
            if (match && match[1]) {
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe src="https://gfycat.com/ifr/${match[1]}"
                                frameborder="0" 
                                scrolling="no" 
                                allowfullscreen
                                style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;">
                        </iframe>
                    </div>
                `;
            }
            return null; 
        },

        getTwitchClipEmbed(htmlContent) {
            if (!htmlContent) return null;
            const regex = /href="(?:https?:\/\/)?(?:www\.)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)"/;
            const match = htmlContent.match(regex);
            
            if (match && match[1]) {
                const clipId = match[1];
                const parentDomain = window.location.hostname;
                
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe src="https://clips.twitch.tv/embed?clip=${clipId}&parent=${parentDomain}"
                                frameborder="0" 
                                scrolling="no"
                                allowfullscreen
                                style="width: 100%; height: 100%; position: absolute; top: 0; left: 0;">
                        </iframe>
                    </div>
                `;
            }
            return null; 
        },

        copyToClipboard(link, id) {
            try {
                const ta = document.createElement('textarea');
                ta.value = link;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);

                this.copiedArticleId = id;
                setTimeout(() => { this.copiedArticleId = null; }, 2000);
            } catch (e) {
                console.error('Failed to copy to clipboard', e);
            }
        },
        shareArticle(article) {
            if (navigator.share) {
                navigator.share({
                    title: article.title,
                    url: article.link
                });
            } else {
                this.copyToClipboard(article.link, article.id);
            }
        },
        
        async apiRequest(method, url, body = null) {
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
            };
            if (body) {
                options.body = JSON.stringify(body);
            }
            try {
                const response = await fetch(url, options);
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({error: `Error: ${response.status}`}));
                    return { error: errorData.error || `Error: ${response.status}` };
                }
                if (response.status === 204) {
                    return { success: true };
                }
                if (response.headers.get('content-type')?.includes('application/json')) {
                    const data = await response.json();
                    return data;
                }
                return { success: true }; 
            } catch (error) {
                return { error: error.message };
            }
        },
        
        async apiPost(url, body = null) {
            const data = await this.apiRequest('POST', url, body);
            if (data && !data.error) {
                await this.fetchAppData();
            }
            return data;
        },
        async apiPut(url, body) {
            const data = await this.apiRequest('PUT', url, body);
            if (data && !data.error) {
                await this.fetchAppData();
            }
            return data;
        },
        async apiDelete(url) {
            const data = await this.apiRequest('DELETE', url);
            if (data && !data.error) {
                await this.fetchAppData();
            }
            return data;
        },
    }));
});