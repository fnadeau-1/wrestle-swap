        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
        import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
        import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
        import { getFirestore, collection, addDoc, updateDoc, increment, query, orderBy, onSnapshot, serverTimestamp, where, doc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

        const firebaseConfig = {
            apiKey: "AIzaSyBjDNViO7zXGDIT6gN7qP1VLU2H1lZphe0",
            authDomain: "grappletrade.firebaseapp.com",
            projectId: "grappletrade",
            storageBucket: "grappletrade.firebasestorage.app",
            messagingSenderId: "119683736855",
            appId: "1:119683736855:web:0d0bc6cea784290ded8352",
            measurementId: "G-987DNCH23C"
        };

        const app = initializeApp(firebaseConfig);
        initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider('6Lck5w4tAAAAABZvUgLj4J5zg_CPlK7mQawuk6b6'), isTokenAutoRefreshEnabled: true });
        const auth = getAuth(app);
        const db = getFirestore(app);

        let currentUser = null;
        let currentConversationId = null;
        let currentConversationData = null;
        let unsubscribeMessages = null;
        let unsubscribeConversations = null;

        // Read ?conv= param from URL — auto-open this conversation when list loads
        const urlParams = new URLSearchParams(window.location.search);
        let pendingConvId = urlParams.get('conv') || null;

        // Check authentication
        onAuthStateChanged(auth, (user) => {
            if (user) {
                currentUser = user;

                // Build user dropdown menu
                const menuWrapper = document.getElementById('user-menu-wrapper');
                const firstName = user.displayName ? user.displayName.split(' ')[0] : user.email.split('@')[0];
                menuWrapper.innerHTML = `
                    <div class="user-menu-container">
                        <button class="top-bar-btn" onclick="window.location.href='profile.html'">Hi, ${escapeHtml(firstName)}!</button>
                        <div class="dropdown-menu">
                            <a href="watchlist.html">Watchlist</a>
                            <a href="my-orders.html">Your Orders</a>
                            <a href="listings-manager.html">Your Listings</a>
                            <a href="messages.html">Messages</a>
                        </div>
                    </div>`;

                loadConversations();
            } else {
                window.location.href = 'sign-in.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
            }
        });

        // Load all conversations for the current user in real-time
        function loadConversations() {
            const conversationsList = document.getElementById('conversations-list');

            // Show loading state (already rendered in HTML by default)
            conversationsList.innerHTML = `
                <div id="conv-loading-state" style="padding:30px 20px;text-align:center;color:#707070;">
                    <div style="display:inline-block;width:32px;height:32px;border:3px solid #e5e5e5;border-top-color:#3665f3;border-radius:50%;animation:conv-spin 1s linear infinite;margin-bottom:12px;"></div>
                    <div style="font-size:14px;">Loading conversations...</div>
                </div>`;

            if (unsubscribeConversations) unsubscribeConversations();

            const q = query(
                collection(db, 'conversations'),
                where('participants', 'array-contains', currentUser.uid),
                orderBy('lastMessageAt', 'desc')
            );

            unsubscribeConversations = onSnapshot(q, (snapshot) => {
                // Filter out conversations the current user has deleted
                const visibleDocs = snapshot.docs.filter(snapDoc => {
                    const d = snapDoc.data();
                    return !d.deletedBy || !d.deletedBy.includes(currentUser.uid);
                });

                if (visibleDocs.length === 0) {
                    conversationsList.innerHTML = `
                        <div style="padding:40px 20px;text-align:center;color:#707070;">
                            <div style="font-size:48px;margin-bottom:12px;opacity:0.4;">💬</div>
                            <div style="font-size:15px;font-weight:600;color:#333;margin-bottom:8px;">No conversations yet</div>
                            <div style="font-size:13px;margin-bottom:16px;">Browse items and message a seller to get started.</div>
                            <a href="search.html" style="display:inline-block;padding:8px 20px;background:#3665f3;color:white;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">Browse Items</a>
                        </div>`;
                    return;
                }

                conversationsList.innerHTML = '';
                visibleDocs.forEach(snapDoc => {
                    const conv = { id: snapDoc.id, ...snapDoc.data() };
                    const isBuyer = conv.buyerId === currentUser.uid;
                    const otherName = isBuyer ? (conv.sellerName || 'Seller') : (conv.buyerName || 'Buyer');
                    const otherUid  = isBuyer ? conv.sellerId : conv.buyerId;
                    const unread    = isBuyer ? (conv.unreadBuyer || 0) : (conv.unreadSeller || 0);

                    const item = document.createElement('div');
                    item.className = 'conversation-item';
                    item.dataset.convId = conv.id;
                    item.innerHTML = `
                        <div class="conversation-avatar">${escapeHtml(otherName[0].toUpperCase())}</div>
                        <div class="conversation-info">
                            <div class="conversation-name">
                                ${escapeHtml(otherName)}
                                ${unread > 0 ? `<span style="background:#c41e3a;color:white;font-size:11px;border-radius:10px;padding:1px 7px;margin-left:6px;">${unread}</span>` : ''}
                            </div>
                            <div class="conversation-preview">
                                ${conv.productName ? `<span style="color:#3665f3;font-size:11px;font-weight:600;">${escapeHtml(conv.productName)}</span> · ` : ''}${conv.lastMessage ? escapeHtml(conv.lastMessage.substring(0, 60)) : '<em>No messages yet</em>'}
                            </div>
                        </div>
                        <div class="conversation-time">${formatTime(conv.lastMessageAt)}</div>
                    `;
                    item.onclick = () => openConversation(conv.id, otherName, otherUid, conv, item);
                    conversationsList.appendChild(item);
                });

                // Auto-open conversation from URL param
                if (pendingConvId) {
                    const target = conversationsList.querySelector(`[data-conv-id="${pendingConvId}"]`);
                    if (target) target.click();
                    pendingConvId = null;
                }
            }, (error) => {
                console.error('Error loading conversations:', error);
                conversationsList.innerHTML = `
                    <div style="padding:30px 20px;text-align:center;color:#dc2626;font-size:14px;">
                        Something went wrong loading your conversations. Please refresh the page.
                    </div>`;
            });
        }

        // Open a specific conversation
        function openConversation(conversationId, otherUserName, otherUserId, convData, clickedItem) {
            currentConversationId = conversationId;
            currentConversationData = convData;

            // Update sidebar active state
            document.querySelectorAll('.conversation-item').forEach(el => el.classList.remove('active'));
            if (clickedItem) clickedItem.classList.add('active');

            // Mark messages as read for current user
            const isBuyer = convData.buyerId === currentUser.uid;
            const unreadField = isBuyer ? 'unreadBuyer' : 'unreadSeller';
            updateDoc(doc(db, 'conversations', conversationId), { [unreadField]: 0 }).catch(() => {});

            // Render chat area
            const chatArea = document.getElementById('chat-area');
            chatArea.innerHTML = `
                <div class="chat-header">
                    <div class="chat-user-avatar">${escapeHtml(otherUserName[0].toUpperCase())}</div>
                    <div class="chat-user-info">
                        <div class="chat-user-name">${escapeHtml(otherUserName)}</div>
                        ${convData.productName ? `<div class="chat-user-status" style="color:#3665f3;">Re: <a href="productdetail.html?id=${convData.productId}" style="color:#3665f3;">${escapeHtml(convData.productName)}</a></div>` : '<div class="chat-user-status">GrappleTrade</div>'}
                    </div>
                    <button class="view-profile-btn" onclick="window.location.href='profile.html?user=${otherUserId}'">
                        View Profile
                    </button>
                    <button class="view-profile-btn" onclick="deleteConversation()" style="color:#dc2626;border-color:#dc2626;" title="Delete this conversation from your inbox">
                        Delete
                    </button>
                </div>
                <div class="messages-area" id="messages-area"></div>
                <div class="message-input-area">
                    <textarea
                        class="message-input"
                        id="message-input"
                        placeholder="Type a message..."
                        rows="1"
                        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage();}"
                    ></textarea>
                    <button class="send-btn" id="send-btn" onclick="sendMessage()" aria-label="Send message">➤</button>
                </div>
            `;

            loadMessages(conversationId, otherUserName);
        }

        // Real-time messages listener
        function loadMessages(conversationId, otherUserName) {
            if (unsubscribeMessages) unsubscribeMessages();

            const messagesRef = collection(db, 'conversations', conversationId, 'messages');
            const q = query(messagesRef, orderBy('timestamp', 'asc'));

            unsubscribeMessages = onSnapshot(q, (snapshot) => {
                const messagesArea = document.getElementById('messages-area');
                if (!messagesArea) return;

                messagesArea.innerHTML = '';
                snapshot.forEach(snapDoc => {
                    const msg = snapDoc.data();
                    const isSent = msg.senderId === currentUser.uid;
                    const label = isSent ? 'You' : otherUserName;

                    const el = document.createElement('div');
                    el.className = `message ${isSent ? 'sent' : ''}`;
                    el.innerHTML = `
                        <div class="message-avatar">${escapeHtml(label[0].toUpperCase())}</div>
                        <div class="message-content">
                            <div class="message-bubble">${escapeHtml(msg.text)}</div>
                            <div class="message-time">${formatTime(msg.timestamp)}</div>
                        </div>
                    `;
                    messagesArea.appendChild(el);
                });

                messagesArea.scrollTop = messagesArea.scrollHeight;
            });
        }

        // Delete conversation from current user's view (soft delete — other party still sees it)
        window.deleteConversation = async function() {
            if (!currentConversationId) return;
            if (!confirm('Remove this conversation from your inbox?\n\nThe other person will still see their copy.')) return;
            try {
                await updateDoc(doc(db, 'conversations', currentConversationId), {
                    deletedBy: arrayUnion(currentUser.uid)
                });
                currentConversationId = null;
                currentConversationData = null;
                if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
                document.getElementById('chat-area').innerHTML = `
                    <div class="empty-state">
                        <div class="empty-icon">💬</div>
                        <div class="empty-text">Select a conversation to start chatting</div>
                    </div>`;
            } catch(e) {
                console.error('Error deleting conversation:', e);
                alert('Could not remove conversation. Please try again.');
            }
        };

        // Show a temporary toast banner in the message thread
        function showToast(msg) {
            let toast = document.getElementById('msg-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'msg-toast';
                toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:white;padding:12px 20px;border-radius:8px;font-size:13px;max-width:360px;text-align:center;z-index:999;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
                document.body.appendChild(toast);
            }
            toast.textContent = msg;
            toast.style.display = 'block';
            clearTimeout(toast._hideTimer);
            toast._hideTimer = setTimeout(() => { toast.style.display = 'none'; }, 6000);
        }

        // Send a message
        window.sendMessage = async function() {
            const input = document.getElementById('message-input');
            const sendBtn = document.getElementById('send-btn');
            const text = input.value.trim();
            if (!text || !currentConversationId || !currentConversationData) return;

            input.value = '';
            if (sendBtn) sendBtn.disabled = true;

            try {
                const isBuyer = currentConversationData.buyerId === currentUser.uid;
                const senderName = currentUser.displayName || currentUser.email.split('@')[0];

                // Write message to subcollection
                await addDoc(collection(db, 'conversations', currentConversationId, 'messages'), {
                    text,
                    senderId: currentUser.uid,
                    senderName,
                    timestamp: serverTimestamp()
                });

                // Update conversation metadata; also remove self from deletedBy if they had cleared it
                await updateDoc(doc(db, 'conversations', currentConversationId), {
                    lastMessage: text.substring(0, 100),
                    lastMessageAt: serverTimestamp(),
                    lastSenderId: currentUser.uid,
                    [isBuyer ? 'unreadSeller' : 'unreadBuyer']: increment(1),
                    deletedBy: arrayRemove(currentUser.uid)
                });

                // Notify recipient via email + in-app (best-effort, never blocks the send).
                // Response includes warning flag if off-platform solicitation was detected.
                try {
                    const idToken = await currentUser.getIdToken();
                    const notifyRes = await fetch('https://us-central1-grappletrade.cloudfunctions.net/notifyNewMessage', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                        body: JSON.stringify({ conversationId: currentConversationId, messagePreview: text }),
                    }).catch(() => null);
                    if (notifyRes && notifyRes.ok) {
                        const notifyData = await notifyRes.json().catch(() => ({}));
                        if (notifyData.warning === 'off_platform_solicitation') {
                            showToast('Keep transactions on GrappleTrade to stay protected by Buyer Protection. Off-platform payments are not covered.');
                        }
                    }
                } catch (_) { /* never block the UI */ }

                input.focus();
            } catch (err) {
                console.error('Error sending message:', err);
                alert('Failed to send message. Please try again.');
            } finally {
                if (sendBtn) sendBtn.disabled = false;
            }
        };

        // Format Firestore timestamp to human-readable relative time
        function formatTime(timestamp) {
            if (!timestamp) return '';
            const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
            const diff = Date.now() - date.getTime();
            if (diff < 60000)   return 'Just now';
            if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
            return date.toLocaleDateString();
        }

        // XSS prevention
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = String(text);
            return div.innerHTML;
        }
