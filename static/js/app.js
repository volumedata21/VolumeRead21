// --- Helper for seeking YouTube embeds ---
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

        // *** NEW: Smart Cap State ***
        smartFeedCap: localStorage.getItem('smartFeedCap') !== 'false', // Default to true
        
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
            this.setupKeyboardShortcuts(); 

            // *** NEW: Handle Browser Back Button (popstate) ***
            window.addEventListener('popstate', (event) => {
                // If the user hits Back, and the modal is open...
                if (this.isModalOpen) {
                    // Close the modal UI
                    this.isModalOpen = false;
                    // Clean up the player/variables
                    this.cleanupModal();
                }
            });

            this.isRefreshing = true;
            await this.fetchAppData();
            await this.fetchArticles(true); 
            this.isRefreshing = false;
            
            setInterval(() => this.refreshAllFeeds(true), 15 * 60 * 1000);
        },

        // --- Keyboard Shortcuts (J/K Navigation) ---
        setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

                const key = e.key.toLowerCase();

                if (key === 'j' || key === 'k') {
                    const articles = this.filteredArticles;
                    if (articles.length === 0) return;

                    let newIndex = -1;

                    if (key === 'j') {
                        newIndex = this.activeArticleIndex + 1;
                    } else if (key === 'k') {
                        newIndex = this.activeArticleIndex - 1;
                    }

                    if (newIndex >= 0 && newIndex < articles.length) {
                        this.activeArticleIndex = newIndex;
                        const nextArticle = articles[newIndex];
                        this.openModal(nextArticle); 
                    }
                }

                if (this.isModalOpen && this.modalArticle) {
                    if (key === 'f') this.toggleFavorite(this.modalArticle);
                    if (key === 'b') this.toggleBookmark(this.modalArticle);
                    if (key === 'v') window.open(this.modalArticle.link, '_blank');
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

        // --- Helper: Clean Text for List View ---
        cleanText(htmlContent) {
            if (!htmlContent) return '';
            let text = htmlContent.replace(/<[^>]*>?/gm, ''); 
            const txt = document.createElement("textarea");
            txt.innerHTML = text; 
            return txt.value;
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

            // *** FIXED: URL construction happens entirely at the start ***
            let url = `/api/articles?page=${this.currentPage}`;
            
            if (this.unreadOnly) {
                url += '&unread_only=true';
            }
            
            // Add Smart Cap parameter
            url += `&smart_cap=${this.smartFeedCap}`; 

            // Add View Type logic
            url += `&view_type=${this.currentView.type}`;
            if (this.currentView.id) {
                url += `&view_id=${this.currentView.id}`;
            }
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
                const payload = { force: !isAutoRefresh };
                await fetch('/api/refresh_all_feeds', { 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
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
            if (this.currentView.type === 'threads') return 'Posts';
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
            this.fetchArticles(true); 
        },

        // *** NEW: Toggle Function for Settings ***
        toggleSmartCap() {
            this.smartFeedCap = !this.smartFeedCap;
            localStorage.setItem('smartFeedCap', this.smartFeedCap);
            // Refresh view to apply change if we are on 'All Feeds'
            if (this.currentView.type === 'all') {
                this.fetchArticles(true);
            }
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
            let type = this.currentView.type;
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
                if (type === 'custom_stream') type = 'stream';
                this.openEditModal(type, id, title);
            }
        },

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
                const viewType = (type === 'stream') ? 'custom_stream' : type;
                if (this.currentView.type === viewType && this.currentView.id === id) {
                     this.setView(viewType, id, newName);
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
            article.is_read = true; 
            await this.apiPost(`/api/article/${article.id}/mark_read`);
        },

        async markAllRead() {
            if (!confirm('Mark all visible articles as read?')) return;
            
            const payload = {
                view_type: this.currentView.type,
                view_id: this.currentView.id
            };
            
            await this.apiPost('/api/mark_all_read', payload);
            this.articles.forEach(a => a.is_read = true);
        },
        
        // --- Modal & Autoplay ---
        openModal(article) {
            if (this.ytPlayer) {
                try { this.ytPlayer.destroy(); } catch(e) {}
                this.ytPlayer = null;
            }

            this.markAsRead(article); 

            const currentList = this.filteredArticles;
            this.activeArticleIndex = currentList.findIndex(a => a.id === article.id);

            this.modalArticle = article;
            this.isModalOpen = true;

            // *** NEW: Push History State ***
            window.history.pushState({ modalOpen: true }, '', `#article-${article.id}`);
            
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
                this.initVideoWatcher();
            });
        },

        closeModal() {
            // *** NEW: Go back in history if we opened it via pushState ***
            if (this.isModalOpen) {
                if (window.history.state && window.history.state.modalOpen) {
                    window.history.back(); 
                } else {
                    this.isModalOpen = false;
                    this.cleanupModal();
                }
            }
        },

        cleanupModal() {
            setTimeout(() => {
                this.modalArticle = null;
                this.modalEmbedHtml = null; 
                if (this.ytPlayer) {
                    try { this.ytPlayer.destroy(); } catch(e) {}
                    this.ytPlayer = null;
                }
            }, 200);
        },

        // ... rest of video/embed functions ...
        // (No logic changes needed here, just formatting/wrapping up)
        
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