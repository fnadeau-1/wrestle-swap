        // ── Price guidance ────────────────────────────────────────────────────
        const PRICE_SUGGESTIONS_URL = 'https://us-central1-grappletrade.cloudfunctions.net/getPriceSuggestions';
        let priceSuggestionTimeout = null;

        async function loadPriceGuidance(category) {
            const box = document.getElementById('price-guidance');
            if (!box || !category) { if (box) box.style.display = 'none'; return; }
            box.style.display = 'block';
            box.textContent = 'Loading price data...';
            try {
                const user = typeof auth !== 'undefined' && auth.currentUser;
                const headers = {};
                if (user) {
                    const token = await user.getIdToken();
                    headers['Authorization'] = `Bearer ${token}`;
                }
                const res = await fetch(`${PRICE_SUGGESTIONS_URL}?category=${encodeURIComponent(category)}`, { headers });
                if (!res.ok) throw new Error('fetch failed');
                const data = await res.json();
                if (data.count === 0) {
                    box.textContent = 'No recent sales in this category yet — be the first to set a price!';
                } else {
                    box.innerHTML = `Recent sales in this category: <strong>$${data.min.toFixed(2)}</strong> – <strong>$${data.max.toFixed(2)}</strong> (avg <strong>$${data.avg.toFixed(2)}</strong> across ${data.count} sale${data.count !== 1 ? 's' : ''})`;
                }
            } catch (e) {
                box.style.display = 'none';
            }
        }

        document.getElementById('category').addEventListener('change', function() {
            clearTimeout(priceSuggestionTimeout);
            priceSuggestionTimeout = setTimeout(() => loadPriceGuidance(this.value), 300);
        });
        // ─────────────────────────────────────────────────────────────────────

        let selectedFiles = [];

        document.getElementById('file-upload').addEventListener('change', function(e) {
            handleFiles(e.target.files);
        });

        const uploadArea = document.getElementById('upload-area');

        uploadArea.addEventListener('dragover', function(e) {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', function(e) {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });

        function compressImage(file) {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const img = new Image();
                    img.onload = function() {
                        const maxDim = 1200;
                        let width = img.width;
                        let height = img.height;

                        if (width > maxDim || height > maxDim) {
                            if (width > height) {
                                height = Math.round(height * maxDim / width);
                                width = maxDim;
                            } else {
                                width = Math.round(width * maxDim / height);
                                height = maxDim;
                            }
                        }

                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

                        canvas.toBlob((blob) => {
                            resolve(new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() }));
                        }, 'image/jpeg', 0.8);
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        async function handleFiles(files) {
            const fileArray = Array.from(files);

            if (selectedFiles.length + fileArray.length > 6) {
                alert('You can only upload up to 6 photos');
                return;
            }

            for (const file of fileArray) {
                if (file.type.startsWith('image/')) {
                    const compressed = await compressImage(file);
                    selectedFiles.push(compressed);
                    displayPreview(compressed);
                }
            }
        }

        function displayPreview(file) {
            const reader = new FileReader();
            reader.onload = function(e) {
                const previewContainer = document.getElementById('preview-container');
                const index = selectedFiles.indexOf(file);

                const previewItem = document.createElement('div');
                previewItem.className = 'preview-item';
                previewItem.innerHTML = `
                    <img src="${e.target.result}" class="preview-image" alt="Preview">
                    <button type="button" class="remove-image" onclick="removeImage(${index})">×</button>
                `;

                previewContainer.appendChild(previewItem);
            };
            reader.readAsDataURL(file);
        }

        window.removeImage = function(index) {
            selectedFiles.splice(index, 1);
            const previewContainer = document.getElementById('preview-container');
            previewContainer.innerHTML = '';
            selectedFiles.forEach(file => displayPreview(file));
        }

        document.getElementById('sell-form').addEventListener('submit', async function(e) {
            e.preventDefault();

            const loading = document.getElementById('loading');
            const submitBtn = document.getElementById('submit-btn');

            loading.style.display = 'block';
            submitBtn.disabled = true;

            // Double-check Stripe account before submission
            const stripeAccountId = window.getStripeAccountId();
            if (!stripeAccountId) {
                alert('You must connect your Stripe account before listing items. Click the button above to get started.');
                loading.style.display = 'none';
                submitBtn.disabled = false;
                return;
            }

            const zipCode = document.getElementById('zip-code').value.trim();
            if (!/^\d{5}(-\d{4})?$/.test(zipCode)) {
                alert('Please enter a valid ZIP code (e.g., 12345).');
                loading.style.display = 'none';
                submitBtn.disabled = false;
                return;
            }

            if (selectedFiles.length === 0) {
                alert('Please add at least one photo');
                loading.style.display = 'none';
                submitBtn.disabled = false;
                return;
            }

            const currentUser = window.getCurrentUser();
            if (!currentUser) {
                alert('You must be signed in to list items');
                loading.style.display = 'none';
                submitBtn.disabled = false;
                return;
            }

            // Enforce max 50 active listings per user
            try {
                const activeSnap = await window.getDocs(
                    window.query(
                        window.collection(window.firestoreDB, 'products'),
                        window.where('userId', '==', currentUser.uid),
                        window.where('active', '==', true)
                    )
                );
                if (activeSnap.size >= 50) {
                    alert('You have reached the maximum of 50 active listings. Please deactivate or delete an existing listing before adding a new one.');
                    loading.style.display = 'none';
                    submitBtn.disabled = false;
                    return;
                }
            } catch (e) {
                console.warn('Could not verify listing count:', e.message);
            }

            // Check for banned keywords before doing any uploads
            const textToCheck = [
                document.getElementById('title').value,
                document.getElementById('description').value,
                document.getElementById('brand').value
            ].join(' ');
            const foundBanned = (window.bannedKeywords || []).find(word =>
                new RegExp('\\b' + word + '\\b', 'i').test(textToCheck)
            );
            if (foundBanned) {
                alert('Your listing contains prohibited content. Please remove any references to weapons, drugs, or inappropriate language and try again.');
                loading.style.display = 'none';
                submitBtn.disabled = false;
                return;
            }

            try {
                // Upload images to Firebase Storage
                const imageUrls = [];
                for (let i = 0; i < selectedFiles.length; i++) {
                    const file = selectedFiles[i];
                    const timestamp = Date.now();
                    const storageReference = window.storageRef(window.firebaseStorage, `product-images/${currentUser.uid}/${timestamp}_${i}_${file.name}`);

                    await window.uploadBytes(storageReference, file);
                    const downloadURL = await window.getDownloadURL(storageReference);
                    imageUrls.push(downloadURL);
                }

                // Prepare product data with seller information
                const productData = {
                    // Product details
                    category: document.getElementById('category').value,
                    title: document.getElementById('title').value,
                    description: document.getElementById('description').value,
                    brand: document.getElementById('brand').value || 'Other',
                    size: document.getElementById('size').value || 'N/A',
                    condition: document.getElementById('condition').value,
                    gender: document.getElementById('gender').value || 'N/A',
                    price: parseFloat(document.getElementById('price').value),
                    images: imageUrls,
                    zipCode: document.getElementById('zip-code').value || '',

                    // Inventory
                    stock: parseInt(document.getElementById('stock').value) || 1,
                    active: true,
                    views: 0,

                    // CRITICAL: Stripe Connect seller ID
                    sellerId: stripeAccountId,  // Stripe Connect account ID for payments

                    // Seller information — do NOT store email here; products are publicly readable
                    userId: currentUser.uid,
                    sellerName: currentUser.displayName || currentUser.email.split('@')[0],

                    // Timestamps
                    createdAt: window.serverTimestamp(),
                    updatedAt: window.serverTimestamp(),
                    status: 'active'
                };

                // Save to Firestore
                const docRef = await window.addDoc(window.collection(window.firestoreDB, 'products'), productData);

                loading.style.display = 'none';
                alert('Item listed successfully! Your Stripe account is connected and ready to receive payments.');
                window.location.href = 'listings-manager.html';

            } catch (error) {
                loading.style.display = 'none';
                submitBtn.disabled = false;
                console.error('Error listing item:', error);
                alert('Error listing item: ' + error.message);
            }
        });
