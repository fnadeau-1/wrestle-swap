        // HTML escape helper — prevents XSS when rendering buyer-supplied address fields
        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // Get order/product ID from URL parameter
        const urlParams = new URLSearchParams(window.location.search);
        const productId = urlParams.get('productId');
        const orderId = urlParams.get('orderId');

        async function loadOrderDetails() {
            // First try to get order info from session storage (if just created)
            const orderInfoStr = sessionStorage.getItem('orderInfo');
            const checkoutProductStr = sessionStorage.getItem('checkoutProduct');

            let orderInfo = null;
            let product = null;

            if (orderInfoStr) {
                try {
                    orderInfo = JSON.parse(orderInfoStr);
                } catch (e) {
                    console.error('Error parsing order info:', e);
                }
            }

            if (checkoutProductStr) {
                try {
                    product = JSON.parse(checkoutProductStr);
                } catch (e) {
                    console.error('Error parsing product:', e);
                }
            }

            // Load from Firebase — cross-reference both products and orders collections
            if (productId && window.firebaseDb) {
                try {
                    const productRef = window.doc(window.firebaseDb, 'products', productId);
                    const ordersQuery = window._fsQuery(
                        window._fsCollection(window.firebaseDb, 'orders'),
                        window._fsWhere('productId', '==', productId),
                        window._fsLimit(1)
                    );

                    const [productSnap, ordersSnap] = await Promise.all([
                        window.getDoc(productRef),
                        window._fsGetDocs(ordersQuery),
                    ]);

                    if (productSnap.exists()) {
                        const fp = productSnap.data();

                        // Fill any missing fields from the orders collection
                        // Sensitive fields (buyerShippingAddress, shippingLabel, rateObjectId) live only in orders
                        if (!ordersSnap.empty) {
                            const orderDoc = ordersSnap.docs[0];
                            const od = orderDoc.data();
                            window._ordersDocId = orderDoc.id; // saved for buyer rating
                            if (!fp.trackingNumber && od.trackingNumber) fp.trackingNumber = od.trackingNumber;
                            if (!fp.trackingUrl && od.trackingUrl) fp.trackingUrl = od.trackingUrl;
                            if (!fp.shippingLabel && od.shippingLabel) fp.shippingLabel = od.shippingLabel;
                            if (!fp.carrier && od.carrier) fp.carrier = od.carrier;
                            if (!fp.buyerShippingAddress && od.buyerShippingAddress) fp.buyerShippingAddress = od.buyerShippingAddress;
                            if (!fp.rateObjectId && od.rateObjectId) fp.rateObjectId = od.rateObjectId;
                            fp.delivered = fp.delivered || od.delivered;
                            fp.autoReleaseCompleted = fp.autoReleaseCompleted || od.autoReleaseCompleted;
                        }

                        // Always populate orderInfo from Firestore
                        orderInfo = orderInfo || {};
                        if (fp.trackingNumber) orderInfo.trackingNumber = fp.trackingNumber;
                        if (fp.trackingUrl) orderInfo.trackingUrl = fp.trackingUrl;
                        if (fp.shippingLabel) orderInfo.labelUrl = fp.shippingLabel;

                        product = product || {};
                        Object.assign(product, fp);
                    }
                } catch (error) {
                    console.error('Error loading from Firebase:', error);
                }
            }

            // Display the information
            displayOrderInfo(orderInfo, product);
        }

        function displayOrderInfo(orderInfo, product) {
            // Display order ID
            const displayOrderId = orderId || (orderInfo?.orderId) || 'N/A';
            document.getElementById('order-id').textContent = displayOrderId;

            // Display order date — use actual soldTimestamp from Firestore if available
            const orderTs = (product && product.soldTimestamp) ? new Date(product.soldTimestamp) : new Date();
            document.getElementById('order-date').textContent = orderTs.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            // Display shipping service
            const shippingService = orderInfo?.shippingService || 'Standard Shipping';
            document.getElementById('shipping-service').textContent = shippingService;

            // Display tracking number
            if (orderInfo?.trackingNumber) {
                document.getElementById('tracking-number').textContent = orderInfo.trackingNumber;
                document.getElementById('tracking-number-display').textContent = orderInfo.trackingNumber;
            } else {
                document.getElementById('tracking-number').textContent = 'Not available';
                document.getElementById('tracking-number-display').textContent = 'Not available';
            }

            // Set up shipping label download button (check both orderInfo and product doc)
            const labelUrl = orderInfo?.labelUrl || (product && product.shippingLabel) || null;
            if (labelUrl) {
                const downloadBtn = document.getElementById('download-label-btn');
                downloadBtn.href = labelUrl;
                downloadBtn.style.display = 'inline-block';
                // Generate QR code for carrier-location printing
                generateQR(labelUrl);
            } else {
                document.getElementById('download-label-btn').style.display = 'none';
            }

            // Set up tracking button
            const trackingUrlVal = orderInfo?.trackingUrl || (product && product.trackingUrl) || null;
            if (trackingUrlVal) {
                const trackBtn = document.getElementById('track-shipment-btn');
                trackBtn.href = trackingUrlVal;
            } else {
                document.getElementById('track-shipment-btn').style.display = 'none';
            }

            // Display product
            if (product) {
                displayProduct(product);

                // Update package dimensions if available from Firebase
                if (product.packageDimensions) {
                    const dims = product.packageDimensions;
                    const packageInfoDiv = document.querySelector('.package-info');
                    if (packageInfoDiv) {
                        packageInfoDiv.innerHTML = `
                            <div class="package-row">
                                <span>Package Size:</span>
                                <span>${dims.length}" x ${dims.width}" x ${dims.height}"</span>
                            </div>
                            <div class="package-row">
                                <span>Weight:</span>
                                <span>${dims.weight} ${dims.weightUnit || 'lbs'}</span>
                            </div>
                        `;
                    }
                }
            }

            // Display buyer's shipping address if stored, otherwise point to label
            const addr = product && product.buyerShippingAddress;
            if (addr && addr.street1) {
                document.getElementById('shipping-address').innerHTML = `
                    <div class="address-title">Buyer's Shipping Address:</div>
                    <div class="address-line">${esc(addr.name)}</div>
                    <div class="address-line">${esc(addr.street1)}${addr.street2 ? ', ' + esc(addr.street2) : ''}</div>
                    <div class="address-line">${esc(addr.city)}, ${esc(addr.state)} ${esc(addr.zip)}</div>
                    <div class="address-line">${esc(addr.country || 'US')}</div>
                `;
            } else {
                document.getElementById('shipping-address').innerHTML = `
                    <div class="address-title">Buyer's Shipping Address:</div>
                    <div class="address-line">
                        The complete shipping address is printed on the shipping label.
                        Please use the downloaded label for accurate address information.
                    </div>
                `;
            }

            // Show create-label button if buyer chose a Shippo rate but label not yet created
            const hasTracking = orderInfo?.trackingNumber || (product && product.trackingNumber);
            const rateObjectId = product && product.rateObjectId;
            if (!hasTracking && rateObjectId && productId) {
                window._pendingRateObjectId = rateObjectId;
                document.getElementById('create-label-section').style.display = 'block';
            }

            // Show buyer rating section if order is delivered/completed
            if (product && (product.delivered || product.autoReleaseCompleted || product.sellerPaidOut)) {
                const ratingSection = document.getElementById('buyer-rating-section');
                if (ratingSection) ratingSection.style.display = 'block';
            }
        }

        function displayProduct(product) {
            const orderItemsDiv = document.getElementById('order-items');

            // Support both field naming conventions (title from Firestore, name from sessionStorage)
            const displayName = product.name || product.title || 'Product';
            // Support both images[] array (from Firestore) and image string (from sessionStorage)
            const imageUrl = product.image || (product.images && product.images[0]) || null;

            const isImageUrl = imageUrl && (
                imageUrl.startsWith('http://') ||
                imageUrl.startsWith('https://') ||
                imageUrl.startsWith('data:image')
            );

            const imageHtml = isImageUrl
                ? `<img src="${esc(imageUrl)}" alt="${esc(displayName)}">`
                : '📦';

            orderItemsDiv.innerHTML = `
                <div class="order-item">
                    <div class="item-image">${imageHtml}</div>
                    <div class="item-details">
                        <div class="item-name">${esc(displayName)}</div>
                        ${product.condition ? `<div class="item-condition">Condition: ${esc(product.condition)}</div>` : ''}
                        <div class="item-price">Sold for: $${(product.price || 0).toFixed(2)}</div>
                    </div>
                </div>
            `;
        }

        const SHIPPO_CREATE_LABEL_URL = 'https://us-central1-grappletrade.cloudfunctions.net/shippoCreateLabel';

        function generateQR(url) {
            if (!url) return;
            const container = document.getElementById('label-qr-container');
            const canvas = document.getElementById('label-qr-canvas');
            if (!container || !canvas) return;
            // Use QRCode library (loaded below)
            if (typeof QRCode === 'undefined') {
                // Library not yet loaded — retry after a moment
                setTimeout(() => generateQR(url), 500);
                return;
            }
            QRCode.toCanvas(canvas, url, { width: 200, margin: 2 }, (err) => {
                if (!err) container.style.display = 'block';
            });
        }

        async function createLabel() {
            const rateObjectId = window._pendingRateObjectId;
            const btn = document.getElementById('create-label-btn');
            const errorEl = document.getElementById('create-label-error');
            if (!rateObjectId || !productId) return;

            btn.disabled = true;
            btn.textContent = 'Creating label...';
            errorEl.style.display = 'none';

            try {
                const idToken = await window.getIdToken();
                const response = await fetch(SHIPPO_CREATE_LABEL_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`,
                    },
                    body: JSON.stringify({ rateObjectId, labelFileType: 'PDF', async: false, productId }),
                });
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}));
                    throw new Error(err.error || `Error ${response.status}`);
                }
                const result = await response.json();

                if (result.status !== 'SUCCESS') {
                    throw new Error(result.messages?.[0]?.text || 'Label creation failed');
                }

                const labelUrl = result.label_url;
                const trackingNumber = result.tracking_number;
                const trackingUrl = result.tracking_url_provider;

                // Update tracking display
                if (trackingNumber) {
                    document.getElementById('tracking-number').textContent = trackingNumber;
                    document.getElementById('tracking-number-display').textContent = trackingNumber;
                }

                // Update download button
                if (labelUrl) {
                    const downloadBtn = document.getElementById('download-label-btn');
                    downloadBtn.href = labelUrl;
                    downloadBtn.style.display = 'inline-block';
                    generateQR(labelUrl);
                }

                // Update track button
                if (trackingUrl) {
                    const trackBtn = document.getElementById('track-shipment-btn');
                    trackBtn.href = trackingUrl;
                    trackBtn.style.display = '';
                }

                // Replace create-label section with success message
                document.getElementById('create-label-section').innerHTML = `
                    <div style="background:#d4edda;border-left:4px solid #28a745;padding:16px;border-radius:6px;">
                        <strong style="color:#155724;">Label created!</strong>
                        <p style="margin:6px 0 0;color:#155724;font-size:14px;">Download it above or scan the QR code at the carrier. The buyer has been notified.</p>
                    </div>`;
            } catch (err) {
                console.error('createLabel error:', err);
                errorEl.textContent = 'Failed: ' + err.message;
                errorEl.style.display = 'block';
                btn.disabled = false;
                btn.textContent = 'Create Shipping Label';
            }
        }

        const MARK_AS_SHIPPED_URL = 'https://us-central1-grappletrade.cloudfunctions.net/markAsShipped';

        // loadOrderDetails is called by onAuthStateChanged after ownership is verified.
        // If productId is not in the URL (e.g. seller arriving right after checkout),
        // we still allow sessionStorage-only display since there's nothing to verify against.
        window.addEventListener('DOMContentLoaded', () => {
            if (!urlProductId) {
                loadOrderDetails();
            }
            // If urlProductId is set, wait for onAuthStateChanged to verify and call us.
        });
