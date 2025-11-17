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
        isRefreshing: false,
        copiedArticleId: null,
        
        // --- Sidebar State ---
        openCategoryIDs: [],
        openStreamIDs: [],

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
        
        // --- Drag & Drop State ---
        draggingFeedId: null,
        dragOverCategoryId: null,
        dragOverStreamId: null,

        // --- NEW: Bulk Assign State ---
        selectedFeedIds: [], // Array of feed IDs
        isAssignModalOpen: false,
        assignModalCategoryId: 'none', // 'none' or a category ID
        assignModalStreamIds: [], // Array of stream IDs

        // --- Init Function ---
        async init() {
            this.isRefreshing = true;
            await this.fetchAppData();
            await this.fetchArticles(true); // Fetch first page
            this.isRefreshing = false;
            
            // Auto-refresh every 15 minutes
            setInterval(() => this.refreshAllFeeds(true), 15 * 60 * 1000);
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

            // Don't fetch if already loading or no more pages
            if (this.isLoadingArticles || (this.currentPage > 1 && !this.hasNextPage)) {
                return; 
            }

            this.isLoadingArticles = true;

            let url = `/api/articles?page=${this.currentPage}`;
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
                this.currentPage += 1; // Increment for the *next* call
                
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
                // On success, reload everything
                await this.fetchAppData();
                await this.fetchArticles(true); // Refetch articles for current view
            } catch (error) {
                console.error('Error refreshing feeds:', error);
            } finally {
                this.isRefreshing = false;
            }
        },
        
        // --- Computed Properties (Getters) ---
        get currentTitle() {
            if (this.currentView.type === 'all') return 'All Feeds';
            if (this.currentView.type === 'favorites') return 'Favorites';
            if (this.currentView.type === 'readLater') return 'Read Later';
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

            // 1. Filter by Search
            if (this.searchQuery.trim() !== '') {
                const query = this.searchQuery.toLowerCase();
                articles = articles.filter(a =>
                    a.title.toLowerCase().includes(query) ||
                    (a.summary && a.summary.toLowerCase().includes(query)) ||
                    a.feed_title.toLowerCase().includes(query) ||
                    a.author.toLowerCase().includes(query)
                );
            }

            // 2. Sort
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
            this.currentView = { type, id, title };
            this.searchQuery = ''; // Clear search on view change
            this.fetchArticles(true); // Fetch articles for the new view
            this.isMobileMenuOpen = false;
        },
        
        loadMoreArticles() {
            this.fetchArticles(false); // Fetch next page
        },
        
        handleScroll(event) {
            const el = event.target;
            // Check if scrolled to near the bottom (within 300px)
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
                this.loadMoreArticles();
            }
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
        
        // --- Sidebar Feed/Stream Helpers ---
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
            // Prevent drag if a feed is selected
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
        // Basic touch-to-drag simulation
        handleTouchStart(feedId, event) {
            if (this.selectedFeedIds.length > 0) {
                event.preventDefault();
                return;
            }
            this.draggingFeedId = feedId;
            // For now, just logging it.
            console.log('Dragging feed: ', feedId);
        },

        // --- NEW: Bulk Feed Assignment ---
        clearSelection() {
            this.selectedFeedIds = [];
        },
        openAssignModal() {
            // Reset modal state
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
                alert("Error assigning feeds: " + data.error); // Simple error feedback
            } else {
                // Success
                this.isAssignModalOpen = false;
                this.clearSelection();
                // apiPost already re-fetches appData, which is perfect
            }
        },

        // --- API: Feed Management ---
        async addFeed() {
            this.feedError = '';
            if (!this.newFeedUrl) return;
            const data = await this.apiPost('/api/add_feed', { url: this.newFeedUrl });
            if (data.error) {
                this.feedError = data.error;
            } else {
                this.newFeedUrl = '';
                // Don't need full refresh, just reload appData and articles
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
        // *** CHANGE 2: Add Rename Feed Function ***
        async renameFeed(feedId, currentName) {
            const newName = prompt('Enter new feed name:', currentName);
            if (!newName || newName.trim() === '' || newName === currentName) return;
            // Use apiPut, which will refetch data on success
            await this.apiPut(`/api/feed/${feedId}`, { name: newName });
        },

        // --- API: Category Management ---
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
        async renameCategory(categoryId, currentName) {
            const newName = prompt('Enter new category name:', currentName);
            if (!newName || newName.trim() === '' || newName === currentName) return;
            await this.apiPut(`/api/category/${categoryId}`, { name: newName });
        },

        // --- API: Stream Management ---
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

        // --- API: Article Actions ---
        async toggleFavorite(article) {
            const response = await this.apiPost(`/api/article/${article.id}/favorite`);
            if (response && typeof response.is_favorite !== 'undefined') {
                article.is_favorite = response.is_favorite;
                // If in favorites view, refetch
                if (this.currentView.type === 'favorites') {
                    await this.fetchArticles(true);
                }
            }
        },
        async toggleBookmark(article) {
            const response = await this.apiPost(`/api/article/${article.id}/bookmark`);
            if (response && typeof response.is_read_later !== 'undefined') {
                article.is_read_later = response.is_read_later;
                // If in read later view, refetch
                if (this.currentView.type === 'readLater') {
                    await this.fetchArticles(true);
                }
            }
        },
        
        // --- Modal & Sharing ---
        openModal(article) {
            this.modalArticle = article;
            this.isModalOpen = true;
        },
        renderModalContent(article) {
            // This is NOT safe for production, but matches your code.
            // A proper HTML sanitizer (like DOMPurify) is recommended.
            if (!article.full_content) return '<p>' + article.summary + '</p>';
            return article.full_content;
        },
        shareArticle(article) {
            if (navigator.share) {
                navigator.share({
                    title: article.title,
                    url: article.link
                });
            } else {
                // Use execCommand as a fallback for clipboard
                try {
                    const ta = document.createElement('textarea');
                    ta.value = article.link;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);

                    this.copiedArticleId = article.id;
                    setTimeout(() => { this.copiedArticleId = null; }, 2000);
                } catch (e) {
                    console.error('Failed to copy to clipboard', e);
                }
            }
        },
        
        // --- API Helper (DRY) ---
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
                // Handle 204 No Content
                if (response.status === 204) {
                    return { success: true };
                }
                // Handle JSON responses
                if (response.headers.get('content-type')?.includes('application/json')) {
                    const data = await response.json();
                    return data;
                }
                return { success: true }; // For non-json success (like DELETE)
            } catch (error) {
                return { error: error.message };
            }
        },
        
        async apiPost(url, body = null) {
            const data = await this.apiRequest('POST', url, body);
            // On any successful POST, reload app data (categories, feeds, etc)
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