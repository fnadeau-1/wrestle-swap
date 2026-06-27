  let selectedStar = 0;
  function selectStar(n) {
    selectedStar = n;
    document.querySelectorAll('.star-btn').forEach((btn, i) => {
      btn.style.color = i < n ? '#ffc107' : '#ccc';
    });
  }
  async function submitBuyerRating() {
    if (!selectedStar) { alert('Please select a star rating.'); return; }
    const comment = document.getElementById('buyer-rating-comment').value.trim();
    const errorDiv = document.getElementById('buyer-rating-error');
    const successDiv = document.getElementById('buyer-rating-success');
    errorDiv.style.display = 'none';
    successDiv.style.display = 'none';
    try {
      const token = await window.getIdToken();
      const res = await fetch('https://us-central1-grappletrade.cloudfunctions.net/submitBuyerRating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          orderId: productId,
          ordersDocId: window._ordersDocId || '',
          rating: selectedStar,
          comment,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit rating');
      document.getElementById('buyer-rating-form').style.display = 'none';
      successDiv.style.display = 'block';
    } catch (e) {
      errorDiv.textContent = e.message;
      errorDiv.style.display = 'block';
    }
  }
