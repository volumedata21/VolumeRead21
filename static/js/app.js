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
        
        // --- Drag & Drop State ---
        draggingFeedId: null,
        dragOverCategoryId: null,
        dragOverStreamId: null,

        // --- Bulk Assign State ---
        selectedFeedIds: [], // Array of feed IDs
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

        // --- Settings/Import/Export State (NEW) ---
        isSettingsModalOpen: false,
        importStatus: '', // 'uploading', 'success', 'error'
        importMessage: '',

        // --- Init Function ---
        async init() {
            this.isRefreshing = true;
            await this.fetchAppData();
            await this.fetchArticles(true); // Fetch first page
            this.isRefreshing = false;
            
            // Auto-refresh every 15 minutes
            setInterval(() => this.refreshAllFeeds(true), 15 * 60 * 1000);
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
            // Check if scrolled to near the bottom (within 300px)
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
            // Initialize view. 
            // We retrieve the layout_style from the appData based on the view type/ID
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
                assigned_style: assignedStyle // Store the user preference
            };
            
            this.searchQuery = '';
            this.fetchArticles(true);
            this.isMobileMenuOpen = false;
        },
        
        // --- Layout Mode Getter ---
        get layoutMode() {
            // 1. DB User Preference (Specific feed/category settings)
            if (this.currentView.assigned_style && this.currentView.assigned_style !== 'default') {
                return this.currentView.assigned_style;
            }

            // 2. Global View User Preference (Local Storage)
            // Only applies if we are in one of those top-level views
            if (['all', 'videos', 'threads', 'sites', 'favorites', 'readLater'].includes(this.currentView.type)) {
                const localStyle = localStorage.getItem('style_' + this.currentView.type);
                if (localStyle && localStyle !== 'default') {
                    return localStyle;
                }
            }

            // 3. System Defaults (Fallback)
            if (this.currentView.type === 'threads' || this.currentView.is_reddit_source) {
                return 'threads';
            }
            if (this.currentView.type === 'videos') {
                return 'videos';
            }
            
            return 'standard'; // Default grid
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

        // --- NEW: Open View Settings (RESTORED) ---
        openViewSettings() {
            // Determine if this is a Global view (All, Videos, Threads) or a DB view
            const type = this.currentView.type;
            const id = this.currentView.id;
            const title = this.currentTitle;

            // Added 'sites' to list of global views
            if (['all', 'videos', 'threads', 'sites', 'favorites', 'readLater'].includes(type)) {
                // Open modal in "Global" mode
                this.editModal = {
                    type: 'global', // Special flag
                    id: type,       // Use the view type as the ID key
                    currentName: title,
                    url: '',
                    layout_style: localStorage.getItem('style_' + type) || 'default'
                };
                this.editModalNewName = title;
                this.editModalError = '';
                this.editModalExcludeAll = false; // Not used for global
                this.isEditModalOpen = true;
            } else {
                // It's a Feed, Category, or Stream -> Use existing logic
                this.openEditModal(type, id, title);
            }
        },

        // --- Edit Modal Functions ---
        openEditModal(type, id, currentName) {
            // Initialize defaults
            this.editModal = { 
                type, 
                id, 
                currentName, 
                url: '', 
                layout_style: 'default' // Default to 'default'
            };
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
                if (cat) {
                    this.editModal.layout_style = cat.layout_style || 'default';
                }
                const feeds = this.getFeedsInCategory(id);
                let allExcluded = feeds.length > 0;
                for (const feed of feeds) {
                    this.editModalFeedStates[feed.id] = feed.exclude_from_all;
                    if (!feed.exclude_from_all) {
                        allExcluded = false;
                    }
                }
                this.editModalExcludeAll = allExcluded;
            } else if (type === 'stream') { 
                const stream = this.appData.customStreams.find(s => s.id === id);
                if (stream) {
                    this.editModal.layout_style = stream.layout_style || 'default';
                }
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
            
            // *** HANDLE GLOBAL VIEWS (LocalStorage) ***
            if (type === 'global') {
                localStorage.setItem('style_' + id, this.editModal.layout_style);
                this.isEditModalOpen = false;
                // Trigger reactivity by "re-setting" the view to itself effectively
                this.currentView = { ...this.currentView }; 
                return;
            }

            // *** HANDLE DB VIEWS (API) ***
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
                // Force view refresh to apply new styles immediately if we are currently viewing this item
                if (this.currentView.type === (type === 'stream' ? 'custom_stream' : type) && this.currentView.id === id) {
                     this.setView(this.currentView.type, id, newName);
                } else {
                    // Otherwise just fetch data to update sidebar titles/state
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
            // Trigger browser download
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
                const response = await fetch('/api/import_opml', {
                    method: 'POST',
                    body: formData
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    this.importStatus = 'success';
                    this.importMessage = data.message;
                    // Refresh app data to show new feeds
                    await this.fetchAppData();
                    // Also trigger a content refresh in background
                    this.refreshAllFeeds(true);
                } else {
                    this.importStatus = 'error';
                    this.importMessage = data.error || 'Import failed';
                }
            } catch (e) {
                this.importStatus = 'error';
                this.importMessage = 'Network error during import';
            }
            
            // Clear input so same file can be selected again if needed
            event.target.value = '';
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
            // This function is now OBSOLETE, but we keep it to prevent errors
            this.openEditModal('feed', feedId, currentName);
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
        renameCategory(categoryId, currentName) {
            this.openEditModal('category', categoryId, currentName);
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
        
        // --- Modal & Sharing ---
        openModal(article) {
            this.modalArticle = article;
            this.isModalOpen = true;
            
            // *** UPDATED: Pre-calculate embed HTML ***
            this.modalEmbedHtml = this.getYouTubeEmbed(article.link) || 
                                  this.getTikTokEmbed(article.link) || 
                                  // REDDIT REMOVED
                                  this.getVimeoEmbed(article.link) || 
                                  this.getDailymotionEmbed(article.link) || 
                                  this.getRedgifsEmbed(article.full_content) || 
                                  this.getImgurEmbed(article.full_content) || 
                                  this.getStreamableEmbed(article.full_content) || 
                                  this.getGfycatEmbed(article.full_content) ||
                                  this.getTwitchClipEmbed(article.full_content) || 
                                  this.getOtherGifEmbed(article.full_content);

            // SCROLL FIX
            // Wait for the modal to be in the DOM, then scroll to top
            this.$nextTick(() => {
                if (this.$refs.modalContent) {
                    this.$refs.modalContent.scrollTop = 0;
                }
            });
        },
        closeModal() {
            this.isModalOpen = false;
            // Wait for transition to finish (200ms) before clearing article
            // to prevent content from disappearing during animation.
            setTimeout(() => {
                this.modalArticle = null;
                this.modalEmbedHtml = null; // NEW: Clear embed HTML
            }, 200);
        },
        
        // *** MODIFIED: Added Formatting Logic for Video Descriptions ***
        renderModalContent(article) {
            let content = article.full_content;

            // Use summary if full_content is empty
            if (!content) {
                content = article.summary || '';
            }

            // *** NEW: Detect and remove duplicate image AND clean text for video embeds ***
            // MODIFIED: If we have a video embed, remove ALL images from the text content
            // to prevent the "still" image from showing up below the video.
            if (this.modalEmbedHtml && content) {
                 try {
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = content;
                    
                    // Remove all images
                    const images = tempDiv.querySelectorAll('img');
                    images.forEach(img => img.remove());

                    // Remove all figures (often contain images)
                    const figures = tempDiv.querySelectorAll('figure');
                    figures.forEach(fig => fig.remove());

                    // Remove "Tik Tok" or "TikTok" generic text if present
                    // This iterates over text nodes to safely remove the specific phrase
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

            // --- Video Description Formatting (YouTube style) ---
            // If we have an embed (video) and content exists, we assume it's a plain-text description
            if (this.modalEmbedHtml && content) {
                // Check if it looks like plain text (no block tags like <p>, <br>, <div>)
                // This prevents us from breaking descriptions that ARE already HTML formatted
                const hasHtmlTags = /<br|<p|<div/i.test(content);
                
                if (!hasHtmlTags) {
                    // 1. Linkify URLs
                    // Matches http/https URLs that are NOT inside quotes or angle brackets
                    const urlRegex = /(https?:\/\/[^\s<"]+)/g;
                    content = content.replace(urlRegex, (url) => {
                        // Handle trailing punctuation often found in text (e.g., "Check this: http://site.com.")
                        const trailing = url.match(/[.,;!)]+$/);
                        let cleanUrl = url;
                        let suffix = '';
                        if (trailing) {
                            suffix = trailing[0];
                            cleanUrl = url.substring(0, url.length - suffix.length);
                        }
                        // Add highlighting classes
                        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="text-[var(--text-highlight)] hover:underline">${cleanUrl}</a>${suffix}`;
                    });

                    // 2. Linkify Timestamps (NEW)
                    // Matches H:MM:SS or M:SS or MM:SS
                    const timestampRegex = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;
                    content = content.replace(timestampRegex, (match, h, m, s) => {
                        let seconds = 0;
                        if (h) {
                            // Format H:MM:SS
                            seconds = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
                        } else {
                            // Format M:SS (or MM:SS)
                            // regex group 1 is undefined, so 'm' is actually group 2, 's' is group 3
                            seconds = parseInt(m) * 60 + parseInt(s);
                        }
                        return `<button onclick="window.seekToTimestamp(${seconds})" class="text-[var(--text-highlight)] hover:underline cursor-pointer">${match}</button>`;
                    });

                    // 3. Convert newlines (Processed last to avoid breaking regexes)
                    // Double newlines -> Paragraphs
                    // Single newlines -> <br>
                    if (content.includes('\n')) {
                        const paragraphs = content.split(/\n\s*\n/);
                        content = paragraphs
                            .map(p => `<p class="mb-4">${p.replace(/\n/g, '<br>')}</p>`)
                            .join('');
                    } else {
                        // Wrap in p tag if it's just one line
                         content = `<p>${content}</p>`;
                    }
                }
            }

            // *** NEW: Detect and remove duplicate image (Fallback for non-video articles) ***
            // Check if there's a main image URL and if we *aren't* showing a video embed.
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
        
        // *** NEW: Helper to determine pill color ***
        getAuthorClass(article) {
            const link = article.link.toLowerCase();
            // Check for Video domains
            if (link.includes('youtube.com') || link.includes('youtu.be') || link.includes('vimeo') || link.includes('dailymotion') || link.includes('tiktok')) {
                return 'pill-video';
            }
            // Check for Thread domains
            if (link.includes('reddit.com') || link.includes('lemmy')) {
                return 'pill-thread';
            }
            // Default
            return 'pill-default';
        },

        // ... Embed Generators ...
        getYouTubeEmbed(link) {
            if (!link) return null;
            // *** UPDATED REGEX to match /watch?v= and /shorts/ ***
            const regex = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)([a-zA-Z0-9_-]{11})/;
            const match = link.match(regex);
            
            if (match && match[1]) {
                const videoId = match[1];
                // Return responsive embed HTML (requires @tailwindcss/aspect-ratio)
                // *** MODIFIED: Added id="yt-player", enablejsapi=1 (for seeking), and autoplay=1 ***
                return `
                    <div class="aspect-w-16 aspect-h-9 rounded-lg overflow-hidden">
                        <iframe id="yt-player" src="https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=1" 
                                frameborder="0" 
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
                                allowfullscreen>
                        </iframe>
                    </div>
                `;
            }
            return null; // Not a YouTube video
        },

        // *** NEW: TIKTOK EMBED FUNCTION ***
        getTikTokEmbed(link) {
            if (!link) return null;
            // Regex for tiktok.com/@user/video/ID
            const regex = /tiktok\.com\/@[\w.]+\/video\/(\d+)/;
            const match = link.match(regex);

            if (match && match[1]) {
                const videoId = match[1];
                // Using the v2 embed iframe endpoint
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
        
        // *** NEW: VIMEO EMBED FUNCTION ***
        getVimeoEmbed(link) {
            if (!link) return null;
            // Regex for vimeo.com/ID
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

        // *** NEW: DAILYMOTION EMBED FUNCTION ***
        getDailymotionEmbed(link) {
            if (!link) return null;
            // Regex for dailymotion.com/video/ID
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

        // REDGIFS EMBED FUNCTION
        getRedgifsEmbed(htmlContent) {
            if (!htmlContent) return null;
            // Look for a redgifs link inside the HTML content
            // This matches watch/ and ifr/ links
            const regex = /href="(?:https?:\/\/)?(?:www\.)?redgifs\.com\/(?:watch|ifr)\/([a-zA-Z0-9_-]+)"/;
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                const videoId = match[1];
                // Use their iframe embed URL
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
            return null; // Not a Redgifs video
        },

        // IMGUR EMBED FUNCTION
        getImgurEmbed(htmlContent) {
            if (!htmlContent) return null;
            // Look for i.imgur.com links ending in .gifv or .mp4
            const regex = /href="(https?:\/\/i\.imgur\.com\/([a-zA-Z0-9]+)\.(mp4|gifv))"/;
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                // We want the .mp4 version for the video tag
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
            return null; // Not an Imgur video
        },

        // OTHER GIF EMBED FUNCTION
        getOtherGifEmbed(htmlContent) {
            if (!htmlContent) return null;
            // Look for any other link ending in .gif (e.g., i.redd.it)
            const regex = /href="([^"]+\.gif)"/;
            const match = htmlContent.match(regex);

            if (match && match[1]) {
                const gifUrl = match[1];
                return `
                    <img class="w-full rounded-lg mb-4" src="${gifUrl}" alt="Embedded GIF">
                `;
            }
            return null; // Not a .gif link
        },
        
        // *** NEW: STREAMABLE EMBED FUNCTION ***
        getStreamableEmbed(htmlContent) {
            if (!htmlContent) return null;
            // Look for a streamable.com link
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
            return null; // Not a Streamable link
        },

        // *** NEW: GFYCAT EMBED FUNCTION ***
        getGfycatEmbed(htmlContent) {
            if (!htmlContent) return null;
            // Look for a gfycat.com link
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
            return null; // Not a Gfycat link
        },

        // TWITCH CLIP EMBED FUNCTION
        getTwitchClipEmbed(htmlContent) {
            if (!htmlContent) return null;
            // Look for a clips.twitch.tv link
            const regex = /href="(?:https?:\/\/)?(?:www\.)?clips\.twitch\.tv\/([a-zA-Z0-9_-]+)"/;
            const match = htmlContent.match(regex);
            
            if (match && match[1]) {
                const clipId = match[1];
                // Twitch requires the parent domain for the embed to work
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
            return null; // Not a Twitch clip
        },

        copyToClipboard(link, id) {
            try {
                // Use execCommand as a fallback for clipboard
                // This is more reliable inside iframes
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
                // Fallback to copy for cards
                this.copyToClipboard(article.link, article.id);
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