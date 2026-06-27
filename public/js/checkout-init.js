        // ============================================
        // HELPERS
        // ============================================

        function esc(str) {
            return String(str ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        // ============================================
        // CLOUD FUNCTION URLS
        // ============================================
        const SHIPPO_GET_RATES_URL = 'https://us-central1-grappletrade.cloudfunctions.net/shippoGetRates';
        const COMPLETE_ORDER_URL = 'https://us-central1-grappletrade.cloudfunctions.net/completeOrder';
        const RECORD_ABANDONED_CART_URL = 'https://us-central1-grappletrade.cloudfunctions.net/recordAbandonedCart';
        const STRIPE_PUBLISHABLE_KEY = 'pk_live_51SVksvGjf88NEQS10ZpIJ0zWBlJ13xbPRvosRWKIOZA10eHIH4p9s1NKrSkwshF9b1IDDS9Uz0w2bnDku3jbG0Jk00zpYZlCNk';

        // Fallback "from" address (only used if seller has no address)
        const FALLBACK_FROM_ADDRESS = {
            name: "GrappleTrade",
            street1: "123 Main Street",
            city: "New York",
            state: "NY",
            zip: "10001",
            country: "US",
            phone: "+1 555-555-5555",
            email: "orders@grappletrade.com"
        };

        // ============================================
        // GLOBAL VARIABLES
        // ============================================

        let checkoutProduct = null;
        let sellerFromAddress = null; // Built from listing's zipCode field
        let subtotal = 0;
        let shippingCost = 0;
        let tax = 0;
        let total = 0;
        let selectedShippingRate = null; // Will store the cheapest Shippo rate
        let usedParcelDimensions = null; // Will store the parcel dimensions used for shipping
        let shippingCalculated = false; // Track if shipping has been calculated

        // ============================================
        // LOAD PRODUCT FROM SESSION STORAGE
        // ============================================

        async function loadCheckoutProduct() {
            const productData = sessionStorage.getItem('checkoutProduct');

            if (!productData) {
                displayEmptyCheckout();
                return;
            }

            try {
                checkoutProduct = JSON.parse(productData);
                calculateTotals();
                displayCheckout();

                // Record abandoned cart (best-effort — fires async, never blocks checkout)
                window.getIdToken().then(idToken => {
                    if (idToken && checkoutProduct && checkoutProduct.id) {
                        fetch(RECORD_ABANDONED_CART_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
                            body: JSON.stringify({ productId: checkoutProduct.id }),
                        }).catch(() => {});
                    }
                }).catch(() => {});

                // Build seller FROM address from the listing's zipCode
                sellerFromAddress = window.getSellerAddress(checkoutProduct);
            } catch (error) {
                console.error('Error loading checkout product:', error);
                displayEmptyCheckout();
            }
        }

        function calculateTotals() {
            if (!checkoutProduct) return;

            subtotal = checkoutProduct.price || 0;

            // Tax calculated server-side via Stripe Tax; $0 shown until payment intent is created
            tax = 0;

            // Total = subtotal + shipping + estimated tax
            total = subtotal + shippingCost + tax;
        }

        function updateOrderSummary() {
            // Update the shipping cost display
            const shippingElement = document.getElementById('shipping-cost');
            const shippingInfoElement = document.getElementById('shipping-info');

            if (shippingElement) {
                if (shippingCalculated && shippingCost > 0) {
                    shippingElement.textContent = '$' + shippingCost.toFixed(2);
                    if (shippingInfoElement && selectedShippingRate) {
                        const serviceName = `${selectedShippingRate.provider} ${selectedShippingRate.servicelevel.name}`;
                        const estimatedDays = selectedShippingRate.estimated_days || 'Standard';
                        const deliveryTime = typeof estimatedDays === 'number'
                            ? `${estimatedDays} business days`
                            : estimatedDays;
                        shippingInfoElement.innerHTML = `<div class="shipping-info-display">${esc(serviceName)} (${esc(String(deliveryTime))})</div>`;
                    }
                } else if (shippingCalculated && shippingCost === 0) {
                    shippingElement.textContent = 'FREE';
                    if (shippingInfoElement) {
                        shippingInfoElement.innerHTML = '<div class="shipping-info-display">Free Shipping Applied</div>';
                    }
                } else {
                    shippingElement.textContent = 'Calculate shipping';
                    if (shippingInfoElement) {
                        shippingInfoElement.innerHTML = '';
                    }
                }
            }

            // Update the tax display
            const taxElement = document.getElementById('tax-cost');
            if (taxElement) {
                taxElement.textContent = '$' + tax.toFixed(2);
            }

            // Update the total display
            const totalElement = document.getElementById('total-amount');
            if (totalElement) {
                totalElement.textContent = '$' + total.toFixed(2);
            }
        }

        function displayEmptyCheckout() {
            const container = document.getElementById('checkout-container');
            container.innerHTML = `
                <div style="grid-column: 1 / -1;">
                    <div class="checkout-section">
                        <div class="empty-cart">
                            <h2 style="font-size: 24px; margin-bottom: 15px;">🛒 Your checkout is empty</h2>
                            <p style="margin-bottom: 20px;">Add items to your cart to continue shopping.</p>
                            <a href="index.html">← Continue Shopping</a>
                        </div>
                    </div>
                </div>
            `;
        }

        function displayCheckout() {
            const container = document.getElementById('checkout-container');

            // Products store images as an array; fall back to legacy single-image field
            const productImage = (checkoutProduct.images && checkoutProduct.images[0]) || checkoutProduct.image || null;
            const productTitle = checkoutProduct.title || checkoutProduct.name || 'Item';
            const isImageUrl = productImage && (
                productImage.startsWith('http://') ||
                productImage.startsWith('https://') ||
                productImage.startsWith('data:image')
            );

            const imageHtml = isImageUrl
                ? `<img src="${esc(productImage)}" alt="${esc(productTitle)}">`
                : esc(productImage || '📦');

            container.innerHTML = `
                <div class="checkout-section">
                    <h1 class="section-title">Checkout</h1>

                    <form id="payment-form">
                        <h3 style="font-size: 18px; margin-bottom: 15px;">Shipping Information</h3>

                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">First Name <span class="required">*</span></label>
                                <input type="text" class="form-input" id="first-name" required>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Last Name <span class="required">*</span></label>
                                <input type="text" class="form-input" id="last-name" required>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Email <span class="required">*</span></label>
                            <input type="email" class="form-input" id="email" required>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Phone Number <span class="required">*</span></label>
                            <input type="tel" class="form-input" id="phone" required>
                        </div>

                        <div class="form-group">
                            <label class="form-label">Address <span class="required">*</span></label>
                            <input type="text" class="form-input" id="address" placeholder="Street address" required>
                        </div>

                        <div class="form-group">
                            <input type="text" class="form-input" id="address2" placeholder="Apartment, suite, etc. (optional)">
                        </div>

                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">City <span class="required">*</span></label>
                                <input type="text" class="form-input" id="city" required>
                            </div>
                            <div class="form-group">
                                <label class="form-label">State <span class="required">*</span></label>
                                <input type="text" class="form-input" id="state" placeholder="NY" required>
                                <p style="font-size: 12px; color: #707070; margin-top: 5px;">No shipping to Hawaii or Alaska.</p>
                            </div>
                        </div>

                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label">ZIP Code <span class="required">*</span></label>
                                <input type="text" class="form-input" id="zip" required maxlength="5" inputmode="numeric" pattern="\d{5}">
                            </div>
                            <div class="form-group">
                                <label class="form-label">Country <span class="required">*</span></label>
                                <input type="text" class="form-input" id="country" value="United States" readonly required>
                                <p style="font-size: 12px; color: #707070; margin-top: 5px;">Only shipping within the United States.</p>
                            </div>
                        </div>

                        <button type="button" class="pay-button calculate-button" id="calculate-shipping-button">
                            Calculate Shipping
                        </button>

                        <div id="shipping-result-message"></div>

                        <h3 style="font-size: 18px; margin: 30px 0 15px 0;">Payment Information</h3>

                        <div class="form-group">
                            <label class="form-label">Payment Information <span class="required">*</span></label>
                            <div id="payment-element"></div>
                            <div id="card-errors" style="color:#c41e3a;font-size:14px;margin-top:8px;min-height:20px;"></div>
                        </div>

                        <div style="background:#f0f7ff;border:1px solid #c8dff7;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1a3a5c;line-height:1.5;">
                            <strong>Payment held securely by Stripe</strong> until you confirm delivery. Funds are only released to the seller after you confirm the item arrived.<br>
                            <span style="margin-top:4px;display:block;color:#555;">You may cancel your order for a full refund before the seller purchases a shipping label. Shipping costs are non-refundable once a label has been purchased.</span>
                        </div>

                        <button type="submit" class="pay-button" id="submit-button" disabled>
                            Complete Purchase
                        </button>

                        <a href="productdetail.html?id=${encodeURIComponent(checkoutProduct.id)}" class="back-to-cart">← Back to Product</a>
                    </form>

                    <div class="security-badges">
                        <div class="checkout-badge">🔒 SSL Encrypted</div>
                        <div class="checkout-badge">💳 Stripe Secure</div>
                        <div class="checkout-badge">✅ PCI Compliant</div>
                        <div class="checkout-badge">📦 Shippo Shipping</div>
                    </div>
                </div>

                <div class="order-summary">
                    <h2 class="summary-title">Order Summary</h2>

                    <div class="order-item">
                        <div class="item-image">${imageHtml}</div>
                        <div class="item-details">
                            <div class="item-name">${esc(productTitle)}</div>
                            ${checkoutProduct.condition ? `<div class="item-condition">${esc(checkoutProduct.condition)}</div>` : ''}
                            <div class="item-price">$${subtotal.toFixed(2)}</div>
                        </div>
                    </div>

                    <div class="summary-row">
                        <span>Subtotal</span>
                        <span>$${subtotal.toFixed(2)}</span>
                    </div>

                    <div class="summary-row">
                        <div>
                            <div>Shipping</div>
                            <div id="shipping-info"></div>
                        </div>
                        <span id="shipping-cost">Calculate shipping</span>
                    </div>

                    <div class="summary-row">
                        <span id="tax-label">Tax (calculated by Stripe)</span>
                        <span id="tax-cost">—</span>
                    </div>

                    <div class="summary-row total">
                        <span>Total</span>
                        <span id="total-amount">$${total.toFixed(2)}</span>
                    </div>
                </div>
            `;

            // Initialize Stripe after DOM is ready
            initializeStripe();

            // Add event listener for the "Calculate Shipping" button
            document.getElementById('calculate-shipping-button').addEventListener('click', calculateShipping);
        }

        // ============================================
        // SHIPPO FUNCTIONS (via Cloud Functions)
        // ============================================

        /**
         * Calculate shipping using Cloud Function (secure - API key not exposed)
         */
        async function calculateShipping() {
            const calculateButton = document.getElementById('calculate-shipping-button');
            const resultMessage = document.getElementById('shipping-result-message');

            // Validate that all required address fields are filled
            const firstName = document.getElementById('first-name').value.trim();
            const lastName = document.getElementById('last-name').value.trim();
            const address = document.getElementById('address').value.trim();
            const city = document.getElementById('city').value.trim();
            const state = document.getElementById('state').value.trim();
            const zip = document.getElementById('zip').value.trim();

            if (!firstName || !lastName || !address || !city || !state || !zip) {
                resultMessage.innerHTML = `
                    <div class="error-message">
                        Please fill in all required shipping address fields first.
                    </div>
                `;
                return;
            }

            // Validate ZIP code format (5 digits, or 5+4)
            if (!/^\d{5}(-\d{4})?$/.test(zip)) {
                resultMessage.innerHTML = '<div class="error-message">Please enter a valid 5-digit ZIP code (e.g., 90210).</div>';
                return;
            }

            // Validate state abbreviation
            const VALID_US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
            if (!VALID_US_STATES.includes(state.toUpperCase())) {
                resultMessage.innerHTML = '<div class="error-message">Please enter a valid 2-letter US state abbreviation (e.g., CA, TX, NY).</div>';
                return;
            }

            // Check for Hawaii or Alaska
            const stateUpper = state.toUpperCase();
            if (stateUpper === 'HI' || stateUpper === 'HAWAII' || stateUpper === 'AK' || stateUpper === 'ALASKA') {
                resultMessage.innerHTML = `
                    <div class="error-message">
                        Sorry, we don't currently ship to Hawaii or Alaska.
                    </div>
                `;
                return;
            }

            // Disable button and show loading state
            calculateButton.disabled = true;
            calculateButton.innerHTML = '<span class="loading-spinner"></span> Calculating shipping...';
            resultMessage.innerHTML = '';

            try {
                // Build the "to" address from the form
                const toAddress = {
                    name: `${firstName} ${lastName}`,
                    street1: address,
                    street2: document.getElementById('address2').value.trim(),
                    city: city,
                    state: state,
                    zip: zip,
                    country: "US"
                };

                // Define package dimensions based on product category
                const packageDimensions = {
                    'Singlet': { length: "10", width: "8", height: "1", distance_unit: "in", weight: "0.5", mass_unit: "lb" },
                    'Shirt': { length: "10", width: "7", height: "1", distance_unit: "in", weight: "0.4", mass_unit: "lb" },
                    'Shorts': { length: "10", width: "8", height: "1.5", distance_unit: "in", weight: "0.6", mass_unit: "lb" },
                    'Pants': { length: "10", width: "8", height: "1.5", distance_unit: "in", weight: "0.6", mass_unit: "lb" },
                    'Shoes': { length: "13", width: "9", height: "4", distance_unit: "in", weight: "2", mass_unit: "lb" },
                    'Bag': { length: "18", width: "14", height: "6", distance_unit: "in", weight: "2.5", mass_unit: "lb" },
                    'Jacket': { length: "18", width: "14", height: "6", distance_unit: "in", weight: "2.5", mass_unit: "lb" },
                    'default': { length: "10", width: "8", height: "4", distance_unit: "in", weight: "2", mass_unit: "lb" }
                };

                // Get the product's category to determine package size
                const productCategory = checkoutProduct.category || 'default';

                // Select the appropriate parcel dimensions
                const parcel = packageDimensions[productCategory] || packageDimensions['default'];

                // Save parcel dimensions globally so we can use them later
                usedParcelDimensions = parcel;

                // Use seller's address if available, otherwise use fallback
                const fromAddress = sellerFromAddress || FALLBACK_FROM_ADDRESS;

                // Validate seller has a FROM zip code
                if (!fromAddress.zip) {
                    throw new Error('This listing is missing a ships-from ZIP code. Please contact the seller.');
                }

                // Get Firebase auth token (required by cloud function)
                const idToken = await window.getIdToken();
                if (!idToken) {
                    throw new Error('Please sign in to calculate shipping');
                }

                // Call Cloud Function to get shipping rates (secure - API key stored in secrets)
                const response = await fetch(SHIPPO_GET_RATES_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify({
                        addressFrom: fromAddress,
                        addressTo: toAddress,
                        parcel: parcel
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error('Cloud Function error:', errorData);
                    throw new Error(errorData.error || `Server error: ${response.status}`);
                }

                const data = await response.json();

                // Check if we got rates back
                if (data.rates && data.rates.length > 0) {
                    // Filter out rates with errors and sort by price (lowest first)
                    const validRates = data.rates
                        .filter(rate => !rate.messages || rate.messages.length === 0)
                        .sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount));

                    if (validRates.length === 0) {
                        throw new Error('No valid shipping rates available for this address');
                    }

                    // Automatically select the cheapest rate
                    selectedShippingRate = validRates[0];
                    shippingCost = parseFloat(selectedShippingRate.amount);
                    shippingCalculated = true;

                    // Update totals and display
                    calculateTotals();
                    updateOrderSummary();

                    // Show success message
                    const serviceName = `${selectedShippingRate.provider} ${selectedShippingRate.servicelevel.name}`;
                    const estimatedDays = selectedShippingRate.estimated_days || 'Standard';
                    const deliveryTime = typeof estimatedDays === 'number'
                        ? `${estimatedDays} business days`
                        : estimatedDays;

                    resultMessage.innerHTML = `
                        <div class="success-message">
                            Shipping calculated: ${esc(serviceName)}<br>
                            Estimated delivery: ${esc(String(deliveryTime))}<br>
                            Cost: $${shippingCost.toFixed(2)}
                        </div>
                    `;

                    // Enable the payment button
                    document.getElementById('submit-button').disabled = false;

                    // Keep Payment Element amount in sync for Apple Pay / Google Pay display
                    if (window._stripeElements) {
                        window._stripeElements.update({ amount: Math.round((subtotal + shippingCost) * 100) });
                    }

                    // Update button text
                    calculateButton.disabled = false;
                    calculateButton.textContent = 'Recalculate Shipping';

                } else {
                    throw new Error('No shipping rates available');
                }

            } catch (error) {
                console.error('Error calculating shipping:', error);
                resultMessage.innerHTML = `
                    <div class="error-message">
                        Error calculating shipping: ${esc(error.message)}<br>
                        Please check your address and try again.
                    </div>
                `;
                calculateButton.disabled = false;
                calculateButton.textContent = 'Calculate Shipping';
            }
        }

        // ============================================
        // COMPLETE ORDER VIA CLOUD FUNCTION
        // ============================================

        async function completeOrder(productId, paymentIntentId, shippingInfo = null) {
            try {
                const idToken = await window.getIdToken();
                if (!idToken) throw new Error('Not authenticated');

                // Collect buyer's shipping address from the form fields
                const buyerShippingAddress = {
                    name: (document.getElementById('first-name').value.trim() + ' ' + document.getElementById('last-name').value.trim()).trim(),
                    street1: document.getElementById('address').value.trim(),
                    street2: (document.getElementById('address2').value || '').trim(),
                    city: document.getElementById('city').value.trim(),
                    state: document.getElementById('state').value.trim(),
                    zip: document.getElementById('zip').value.trim(),
                    country: 'US',
                };

                const body = { productId, paymentIntentId, buyerShippingAddress };

                if (shippingInfo) {
                    body.shippingInfo = shippingInfo;
                }

                if (usedParcelDimensions) {
                    body.packageDimensions = {
                        length: usedParcelDimensions.length,
                        width: usedParcelDimensions.width,
                        height: usedParcelDimensions.height,
                        weight: usedParcelDimensions.weight,
                        unit: usedParcelDimensions.distance_unit,
                        weightUnit: usedParcelDimensions.mass_unit
                    };
                }

                const response = await fetch(COMPLETE_ORDER_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${idToken}`
                    },
                    body: JSON.stringify(body)
                });

                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Failed to complete order');

                return true;
            } catch (error) {
                console.error('Error completing order:', error);
                return false;
            }
        }

        // ============================================
        // STRIPE INTEGRATION
        // ============================================

        function showPaymentOverlay(title, message) {
            document.getElementById('overlay-title').textContent = title;
            document.getElementById('overlay-message').textContent = message;
            document.getElementById('payment-overlay').classList.add('active');
            window.onbeforeunload = () => 'Your payment is being processed. Do not leave this page — you may be charged.';
        }

        function updatePaymentOverlay(title, message) {
            document.getElementById('overlay-title').textContent = title;
            document.getElementById('overlay-message').textContent = message;
        }

        function hidePaymentOverlay() {
            document.getElementById('payment-overlay').classList.remove('active');
            window.onbeforeunload = null;
        }

        function initializeStripe() {
            const stripe = Stripe(STRIPE_PUBLISHABLE_KEY);

            // Payment Element — deferred intent creation (no clientSecret yet;
            // shipping cost is unknown until the buyer enters their address).
            // Uses Stripe's recommended deferred flow: elements({ mode }) → elements.submit()
            // → createPaymentIntent server-side → confirmPayment({ clientSecret }).
            const elements = stripe.elements({
                mode: 'payment',
                amount: Math.round(subtotal * 100), // approximate; updated after shipping calc
                currency: 'usd',
                appearance: {
                    theme: 'stripe',
                    variables: {
                        colorPrimary: '#c41e3a',
                        fontFamily: '"DM Sans", system-ui, sans-serif',
                        borderRadius: '8px',
                    }
                }
            });

            // Expose so calculateShipping() can call elements.update({ amount })
            // to keep Apple Pay / Google Pay totals accurate after shipping is known.
            window._stripeElements = elements;

            const paymentElement = elements.create('payment');
            paymentElement.mount('#payment-element');

            // Handle form submission
            const form = document.getElementById('payment-form');
            const submitButton = document.getElementById('submit-button');

            form.addEventListener('submit', async function(event) {
                event.preventDefault();

                // Check if shipping has been calculated
                if (!shippingCalculated || !selectedShippingRate) {
                    alert('Please calculate shipping before completing your purchase.');
                    return;
                }

                // Disable submit button to prevent multiple submissions
                submitButton.disabled = true;
                submitButton.textContent = 'Processing...';
                showPaymentOverlay('Processing Payment', 'Please do not close or navigate away from this page.');

                try {
                    // Step 1: Validate the Payment Element (catches incomplete card numbers, etc.)
                    const { error: submitError } = await elements.submit();
                    if (submitError) {
                        hidePaymentOverlay();
                        document.getElementById('card-errors').textContent = submitError.message;
                        submitButton.disabled = false;
                        submitButton.textContent = 'Complete Purchase';
                        return;
                    }

                    // Step 2: Create PaymentIntent server-side.
                    // Price, shipping, and seller account are all verified there — never trust the frontend.
                    const idToken = await window.getIdToken();
                    const piResponse = await fetch('https://us-central1-grappletrade.cloudfunctions.net/createPaymentIntent', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${idToken}`,
                        },
                        body: JSON.stringify({
                            productId: checkoutProduct.id,
                            rateObjectId: selectedShippingRate ? selectedShippingRate.object_id : null,
                            currency: 'usd',
                            buyerState: document.getElementById('state').value.trim().toUpperCase(),
                            buyerZip: document.getElementById('zip').value.trim(),
                        })
                    });

                    if (!piResponse.ok) {
                        const errData = await piResponse.json().catch(() => ({}));
                        throw new Error(errData.error || `Unable to prepare payment (${piResponse.status}). Please try again.`);
                    }

                    const data = await piResponse.json();
                    if (data.error) throw new Error(data.error);
                    if (!data.clientSecret) throw new Error('No client secret received from server');

                    // Update tax display from Stripe's server-side automatic_tax calculation
                    const stripeTaxCents = data.taxAmountCents || 0;
                    if (data.taxSource === 'automatic') {
                        tax = stripeTaxCents / 100;
                        total = subtotal + shippingCost + tax;
                        const taxEl = document.getElementById('tax-cost');
                        const taxLabelEl = document.getElementById('tax-label');
                        const totalEl = document.getElementById('total-amount');
                        if (taxEl) taxEl.textContent = '$' + tax.toFixed(2);
                        if (taxLabelEl) taxLabelEl.textContent = 'Sales Tax';
                        if (totalEl) totalEl.textContent = '$' + total.toFixed(2);
                        submitButton.textContent = 'Complete Purchase — $' + total.toFixed(2);
                    }

                    // Sync Apple Pay / Google Pay wallet sheet to tax-inclusive total
                    if (window._stripeElements) {
                        window._stripeElements.update({ amount: Math.round((subtotal + shippingCost + tax) * 100) });
                    }

                    // Step 3: Confirm payment via Payment Element.
                    // redirect: 'if_required' — only redirects for methods that need it (e.g. 3DS,
                    // iDEAL). For regular US cards, Apple Pay, Google Pay: returns immediately.
                    // If a redirect does occur, Stripe sends the buyer back to return_url and the
                    // stripeWebhook Cloud Function handles order completion as a safety net.
                    const { error, paymentIntent } = await stripe.confirmPayment({
                        elements,
                        clientSecret: data.clientSecret,
                        confirmParams: {
                            return_url: window.location.origin + '/order-confirmation.html',
                            payment_method_data: {
                                billing_details: {
                                    name: `${document.getElementById('first-name').value} ${document.getElementById('last-name').value}`.trim(),
                                    email: document.getElementById('email').value,
                                    phone: document.getElementById('phone').value,
                                    address: {
                                        line1: document.getElementById('address').value,
                                        line2: document.getElementById('address2').value || '',
                                        city: document.getElementById('city').value,
                                        state: document.getElementById('state').value,
                                        postal_code: document.getElementById('zip').value,
                                        country: 'US'
                                    }
                                }
                            }
                        },
                        redirect: 'if_required'
                    });

                    if (error) {
                        // Card declined, validation error, authentication failure, etc.
                        hidePaymentOverlay();
                        document.getElementById('card-errors').textContent = error.message;
                        submitButton.disabled = false;
                        submitButton.textContent = 'Complete Purchase';
                        return;
                    }

                    if (paymentIntent && paymentIntent.status === 'succeeded') {
                        // Normal path — no redirect (cards, Apple Pay, Google Pay)
                        // Note: shipping label is purchased by the seller from their fulfillment page,
                        // not here — shippoCreateLabel requires seller auth.

                        // Step 4: Complete order (marks item sold, emails buyer & seller)
                        updatePaymentOverlay('Payment Confirmed!', 'Finalizing your order — almost there, do not close this page.');
                        submitButton.textContent = 'Finalizing order...';
                        const orderSuccess = await completeOrder(checkoutProduct.id, paymentIntent.id, null);
                        if (!orderSuccess) {
                            hidePaymentOverlay();
                            document.getElementById('card-errors').textContent =
                                `Your payment was received but we had trouble recording your order. Please contact support with your payment reference: ${paymentIntent.id}`;
                            submitButton.disabled = false;
                            submitButton.textContent = 'Complete Purchase';
                            return;
                        }

                        // Step 5: Save receipt data and redirect
                        sessionStorage.setItem('orderInfo', JSON.stringify({
                            orderId: paymentIntent.id,
                            shippingService: selectedShippingRate
                                ? `${selectedShippingRate.provider} ${selectedShippingRate.servicelevel.name}`
                                : 'Standard Shipping',
                            subtotal, shippingCost, tax, total,
                        }));

                        updatePaymentOverlay('Order Complete!', 'Redirecting you to your receipt...');
                        window.onbeforeunload = null;
                        window.location.href = 'order-confirmation.html?id=' + paymentIntent.id;

                    } else {
                        // Redirect-based methods (3DS etc.) — confirmPayment already navigated
                        // the browser away; we only land here for truly unexpected statuses.
                        throw new Error('Unexpected payment status: ' + (paymentIntent?.status || 'unknown'));
                    }

                } catch (err) {
                    console.error('Payment error:', err);
                    hidePaymentOverlay();
                    document.getElementById('card-errors').textContent = 'Payment failed: ' + err.message;
                    submitButton.disabled = false;
                    submitButton.textContent = 'Complete Purchase';
                }
            });
        }

        // ============================================
        // INITIALIZE PAGE
        // ============================================

        window.addEventListener('DOMContentLoaded', function() {
            loadCheckoutProduct();
        });
