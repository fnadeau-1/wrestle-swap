        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        const urlParams = new URLSearchParams(window.location.search);
        // Normal flow: ?id=pi_xxx  |  Stripe redirect flow (3DS etc.): ?payment_intent=pi_xxx&redirect_status=succeeded
        const orderId = urlParams.get('id') ||
            (urlParams.get('redirect_status') === 'succeeded' ? urlParams.get('payment_intent') : null);

        // Load order information from session storage
        function loadOrderInfo() {
            if (!orderId) {
                document.getElementById('confirmation-container').innerHTML = `
                    <div class="confirmation-card">
                        <div class="success-header">
                            <div class="success-icon">❌</div>
                            <h1 class="success-title">Order Not Found</h1>
                            <p class="success-subtitle">We couldn't find the order information.</p>
                        </div>
                        <div class="action-buttons">
                            <a href="index.html" class="btn btn-primary">Return to Home</a>
                        </div>
                    </div>
                `;
                return;
            }

            // Display order ID
            document.getElementById('order-id').textContent = orderId;

            // Display order date (current date)
            const orderDate = new Date();
            document.getElementById('order-date').textContent = orderDate.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            // Load order info from session storage
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

            // Try to get product from orderInfo first, then fallback to checkoutProduct
            if (orderInfo && orderInfo.product) {
                product = orderInfo.product;
            } else if (checkoutProductStr) {
                try {
                    product = JSON.parse(checkoutProductStr);
                } catch (e) {
                    console.error('Error parsing product:', e);
                }
            }

            // Display shipping method
            if (orderInfo && orderInfo.shippingService) {
                document.getElementById('shipping-method').textContent = orderInfo.shippingService;
            } else {
                document.getElementById('shipping-method').textContent = 'Standard Shipping';
            }

            // Display tracking info if available
            if (orderInfo && orderInfo.trackingNumber) {
                document.getElementById('tracking-section').style.display = 'block';
                document.getElementById('tracking-number').textContent = orderInfo.trackingNumber;

                if (orderInfo.trackingUrl) {
                    const trackLink = document.getElementById('track-link');
                    trackLink.href = orderInfo.trackingUrl;
                } else {
                    // If no tracking URL, hide the button
                    document.getElementById('track-link').style.display = 'none';
                }
            }

            // Display product information and pricing
            if (product) {
                displayProduct(product, orderInfo);
            } else {
                // If no product info available, show generic message
                document.getElementById('order-items').innerHTML = `
                    <div class="order-item">
                        <div class="item-details">
                            <div class="item-name">Order details unavailable</div>
                            <div class="item-condition">Please check your confirmation email for complete order details.</div>
                        </div>
                    </div>
                `;
            }
        }

        function displayProduct(product, orderInfo) {
            const orderItemsDiv = document.getElementById('order-items');

            // Determine if image is URL or emoji
            const isImageUrl = product.image && (
                product.image.startsWith('http://') ||
                product.image.startsWith('https://') ||
                product.image.startsWith('data:image')
            );

            const imageHtml = isImageUrl
                ? `<img src="${esc(product.image)}" alt="${esc(product.name)}">`
                : '📦';

            orderItemsDiv.innerHTML = `
                <div class="order-item">
                    <div class="item-image">${imageHtml}</div>
                    <div class="item-details">
                        <div class="item-name">${esc(product.name)}</div>
                        ${product.condition ? `<div class="item-condition">Condition: ${esc(product.condition)}</div>` : ''}
                        <div class="item-price">$${(product.price || 0).toFixed(2)}</div>
                    </div>
                </div>
            `;

            // Use actual values from checkout if available, otherwise calculate
            const subtotal = orderInfo?.subtotal ?? product.price ?? 0;
            const shipping = orderInfo?.shippingCost ?? product.shippingCost ?? 0;
            const tax = orderInfo?.tax ?? 0;
            const total = orderInfo?.total ?? (subtotal + shipping + tax);

            document.getElementById('subtotal').textContent = '$' + subtotal.toFixed(2);
            document.getElementById('shipping').textContent = shipping > 0 ? '$' + shipping.toFixed(2) : 'FREE';
            document.getElementById('tax').textContent = '$' + tax.toFixed(2);
            document.getElementById('total').textContent = '$' + total.toFixed(2);
        }

        // Load order info when page loads
        window.addEventListener('DOMContentLoaded', loadOrderInfo);
