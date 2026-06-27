        function performSearch() {
            const searchTerm = document.getElementById('search-input').value;

            let url = 'search.html?';

            if (searchTerm) {
                url += 'q=' + encodeURIComponent(searchTerm);
            }

            if (!searchTerm) {
                url = 'search.html';
            }

            window.location.href = url;
        }
