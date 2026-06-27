        function performSearch() {
            const val = document.getElementById('search-input').value.trim();
            window.location.href = val ? 'search.html?q=' + encodeURIComponent(val) : 'search.html';
        }
