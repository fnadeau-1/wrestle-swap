// FUNCTION: Close the modal
        // This redirects the user to index.html after a fade-out animation
        function closeModal() {
            // Add a fade-out animation
            const overlay = document.getElementById('modalOverlay');
            overlay.style.animation = 'fadeOut 0.3s ease-out';

            // Wait for animation to finish (300ms), then redirect
            setTimeout(() => {
                // Redirect to index.html
                window.location.href = 'index.html';
            }, 300);
        }

        // Add the fade-out animation to our stylesheet dynamically
        const style = document.createElement('style');
        style.textContent = `
            @keyframes fadeOut {
                from { opacity: 1; }
                to { opacity: 0; }
            }
        `;
        document.head.appendChild(style);

        // FUNCTION: Go to seller dashboard
        // Replace this URL with your actual dashboard URL
        function goToDashboard() {
            window.location.href = 'listings-manager.html';
        }

        // FUNCTION: Print the instructions
        // Opens the browser's print dialog
        function printInstructions() {
            window.print();
        }

        // OPTIONAL: Close modal when clicking outside the white box
        document.getElementById('modalOverlay').addEventListener('click', function(event) {
            // Only close if the click was on the overlay itself, not the modal container
            if (event.target === this) {
                closeModal();
            }
        });

        // OPTIONAL: Close modal when pressing Escape key
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
                closeModal();
            }
        });
