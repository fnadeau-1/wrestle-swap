        // ============================================
        // CART DATA - Stored in Firestore
        // ============================================

        function esc(s) {
            return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        let cartItems = [];

        // ============================================
        // FIRESTORE FUNCTIONS - Database operations
        // ============================================

        // Load cart from Firestore database
        async function loadCartFromFirestore() {
            const user = window.getCurrentUser();
            if (!user) {
                console.error('No user logged in');
                return;
            }

            try {
                // Get the user's cart document from Firestore
                const cartRef = window.firebaseDoc(window.firebaseDb, 'carts', user.uid);
                const cartSnap = await window.firebaseGetDoc(cartRef);

                if (cartSnap.exists()) {
                    const cartData = cartSnap.data();
                    cartItems = cartData.items || [];
                } else {
                    cartItems = [];
                }

                // Hide loading overlay
                document.getElementById('loading-overlay').style.display = 'none';

                // Render the cart
                renderCart();
            } catch (error) {
                console.error('Error loading cart:', error);
                document.getElementById('loading-overlay').style.display = 'none';
                alert('Error loading cart. Please refresh the page.');
            }
        }

        // Save cart to Firestore database
        async function saveCartToFirestore() {
            const user = window.getCurrentUser();
            if (!user) {
                console.error('No user logged in');
                return;
            }

            try {
                const cartRef = window.firebaseDoc(window.firebaseDb, 'carts', user.uid);

                // Save the entire cart
                await window.firebaseSetDoc(cartRef, {
                    items: cartItems,
                    updatedAt: new Date().toISOString()
                });
            } catch (error) {
                console.error('Error saving cart:', error);
                alert('Error saving cart. Please try again.');
            }
        }

        // Expose this function globally so Firebase script can call it
        window.loadCartFromFirestore = loadCartFromFirestore;

        // ============================================
        // RENDER CART - Displays all items in the cart
        // ============================================

        function renderCart() {
            const cartItemsContainer = document.getElementById('cart-items');
            const cartLayout = document.getElementById('cart-layout');
            const emptyCart = document.getElementById('empty-cart');
            const cartCount = document.getElementById('cart-count');

            // Check if cart is empty
            if (cartItems.length === 0) {
                // Show empty cart message
                cartLayout.style.display = 'none';
                emptyCart.style.display = 'block';
                cartCount.textContent = '0 items';
                return;
            }

            // Cart has items - show the cart layout
            cartLayout.style.display = 'grid';
            emptyCart.style.display = 'none';

            // Clear existing items
            cartItemsContainer.innerHTML = '';

            // Calculate total item count
            let totalItems = 0;
            cartItems.forEach(item => {
                totalItems += item.quantity;
            });
            cartCount.textContent = totalItems + ' item' + (totalItems !== 1 ? 's' : '');

            // Create HTML for each cart item
            cartItems.forEach((item, index) => {
                // Handle both icon and image properties (product-detail uses 'image')
                const _rawIcon = item.icon || item.image || '';
                const _isImgUrl = _rawIcon && (_rawIcon.startsWith('https://') || _rawIcon.startsWith('http://'));
                const displayIcon = _isImgUrl
                    ? `<img src="${esc(_rawIcon)}" alt="${esc(item.name || '')}" style="width:100%;height:100%;object-fit:cover;">`
                    : esc(_rawIcon || '📦');

                // Handle condition property which might not exist
                const condition = item.condition || 'Used';

                // Handle size - might be in different formats
                const size = item.size || 'One Size';

                // Calculate shipping - default to 0 if not specified
                const shipping = item.shipping || 0;

                const cartItemHTML = `
                    <div class="cart-item" data-item-id="${item.id}">
                        <div class="item-select">
                            <input type="radio" name="checkout-item" value="${item.id}"
                                   onchange="updateCheckoutSelection('${item.id}')">
                        </div>

                        <div class="item-image">${displayIcon}</div>

                        <div class="item-details">
                            <div class="item-title">${esc(item.name)}</div>
                            <div class="item-info">Size: ${esc(size)} | Condition: ${esc(condition)}</div>
                            <div class="item-seller">Sold by: ${esc(item.seller)}</div>
                            <div class="item-actions">
                                <a href="#" class="action-link" onclick="saveForLater('${item.id}'); return false;">
                                    Save for later
                                </a>
                                <a href="#" class="action-link remove-link" onclick="removeItem('${item.id}'); return false;">
                                    Remove
                                </a>
                            </div>
                        </div>

                        <div class="item-price-section">
                            <div class="item-price">$${item.price.toFixed(2)}</div>
                            <div class="item-shipping">
                                ${shipping === 0 ? 'Free shipping' : '+$' + shipping.toFixed(2) + ' shipping'}
                            </div>
                            <div class="quantity-controls">
                                <button class="qty-btn" onclick="updateQty('${item.id}', -1)" aria-label="Decrease quantity">−</button>
                                <div class="qty-display" id="qty-${item.id}" aria-live="polite">${item.quantity}</div>
                                <button class="qty-btn" onclick="updateQty('${item.id}', 1)" aria-label="Increase quantity">+</button>
                            </div>
                        </div>
                    </div>
                `;

                cartItemsContainer.innerHTML += cartItemHTML;
            });
        }

        // ============================================
        // UPDATE QUANTITY - Increase or decrease item quantity
        // ============================================

        async function updateQty(itemId, change) {
            // Find the item in our cart array
            const item = cartItems.find(i => i.id === itemId || i.id === String(itemId));
            if (!item) return;

            // Calculate new quantity
            let newQty = item.quantity + change;

            // Enforce limits (minimum 1, maximum 10)
            if (newQty < 1) newQty = 1;
            if (newQty > 10) newQty = 10;

            // Update the item quantity
            item.quantity = newQty;

            // Save to Firestore
            await saveCartToFirestore();

            // Update the display
            document.getElementById('qty-' + itemId).textContent = newQty;

            // If this item is currently selected for checkout, update the summary
            const selectedRadio = document.querySelector('input[name="checkout-item"]:checked');
            if (selectedRadio && (selectedRadio.value === itemId || selectedRadio.value === String(itemId))) {
                updateCheckoutSelection(itemId);
            }

            // Update the cart count
            renderCart();
        }

        // ============================================
        // REMOVE ITEM - Remove an item from the cart
        // ============================================

        async function removeItem(itemId) {
            if (confirm('Remove this item from your cart?')) {
                // Remove the item from our array
                cartItems = cartItems.filter(item => item.id !== itemId && item.id !== String(itemId));

                // Save to Firestore
                await saveCartToFirestore();

                // Re-render the cart
                renderCart();

                // Reset checkout selection
                updateCheckoutSelection(null);
            }
        }

        // ============================================
        // SAVE FOR LATER - Move item to watchlist
        // ============================================

        async function saveForLater(itemId) {
            await removeItem(itemId);
        }

        // ============================================
        // UPDATE CHECKOUT SELECTION
        // This function runs when a user selects an item
        // ============================================

        function updateCheckoutSelection(itemId) {
            const checkoutBtn = document.getElementById('checkout-btn');

            // If no item selected (itemId is null or undefined)
            if (!itemId) {
                document.getElementById('selected-item-name').textContent = 'None';
                document.getElementById('selected-quantity').textContent = '0';
                document.getElementById('item-total').textContent = '$0.00';
                document.getElementById('total').textContent = '$0.00';
                checkoutBtn.disabled = true;
                return;
            }

            // Find the selected item (handle both string and number IDs)
            const item = cartItems.find(i => i.id === itemId || i.id === String(itemId));
            if (!item) {
                console.error('Item not found:', itemId);
                return;
            }

            // Calculate the total for this item (price × quantity)
            const itemTotal = item.price * item.quantity;

            // Update the summary display
            document.getElementById('selected-item-name').textContent = item.name;
            document.getElementById('selected-quantity').textContent = item.quantity;
            document.getElementById('item-total').textContent = '$' + itemTotal.toFixed(2);
            document.getElementById('total').textContent = '$' + itemTotal.toFixed(2);

            // Enable the checkout button
            checkoutBtn.disabled = false;
        }

        // ============================================
        // PROCEED TO CHECKOUT
        // This saves the selected item's cost and redirects to checkout
        // ============================================

        async function proceedToCheckout() {
            // Get the selected radio button
            const selectedRadio = document.querySelector('input[name="checkout-item"]:checked');

            if (!selectedRadio) {
                alert('Please select an item to checkout');
                return;
            }

            // Get the selected item ID
            const itemId = selectedRadio.value;
            const item = cartItems.find(i => i.id === itemId || i.id === String(itemId));

            if (!item) {
                alert('Error: Item not found');
                console.error('Could not find item with ID:', itemId);
                return;
            }

            // Fetch the full product document from Firestore so checkout.html
            // has all required fields (sellerId, zipCode, category, etc.)
            try {
                const productRef = window.firebaseDoc(window.firebaseDb, 'products', item.id);
                const productSnap = await window.firebaseGetDoc(productRef);

                if (!productSnap.exists()) {
                    alert('This item is no longer available.');
                    return;
                }

                const product = { id: productSnap.id, ...productSnap.data() };

                // Write to sessionStorage in the format checkout.html expects
                sessionStorage.setItem('checkoutProduct', JSON.stringify(product));

                // Redirect to checkout page
                window.location.href = 'checkout.html';
            } catch (err) {
                console.error('Error fetching product for checkout:', err);
                alert('Error loading product. Please try again.');
            }
        }
