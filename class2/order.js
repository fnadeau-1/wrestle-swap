    // Update line totals and summary on quantity change
    var rows = document.querySelectorAll('.order-row');
    rows.forEach(function(row) {
      var input = row.querySelector('.qty');
      var total = row.querySelector('.line-total');
      var price = parseFloat(row.getAttribute('data-price'));
      input.addEventListener('input', function() {
        var qty = Math.max(0, parseInt(this.value) || 0);
        this.value = qty;
        total.textContent = '$' + (price * qty).toFixed(2);
        updateSummary();
      });
    });

    function updateSummary() {
      var subtotal = 0;
      rows.forEach(function(row) {
        var qty = parseInt(row.querySelector('.qty').value) || 0;
        var price = parseFloat(row.getAttribute('data-price'));
        subtotal += price * qty;
      });
      var tax = subtotal * 0.08;
      document.getElementById('subtotal').textContent = '$' + subtotal.toFixed(2);
      document.getElementById('tax').textContent = '$' + tax.toFixed(2);
      document.getElementById('grandTotal').textContent = '$' + (subtotal + tax).toFixed(2);
    }

    // Form submission
    document.getElementById('orderForm').addEventListener('submit', function(e) {
      e.preventDefault();
      var valid = true;

      function showError(id, msg) {
        document.getElementById(id).textContent = msg;
        valid = false;
      }
      function clearError(id) {
        document.getElementById(id).textContent = '';
      }

      var firstName = document.getElementById('firstName').value.trim();
      var lastName  = document.getElementById('lastName').value.trim();
      var email     = document.getElementById('email').value.trim();
      var date      = document.getElementById('pickupDate').value;
      var location  = document.getElementById('pickupLocation').value;

      firstName ? clearError('firstNameError') : showError('firstNameError', 'First name is required.');
      lastName  ? clearError('lastNameError')  : showError('lastNameError',  'Last name is required.');
      email && /\S+@\S+\.\S+/.test(email) ? clearError('emailError') : showError('emailError', 'A valid email is required.');
      date      ? clearError('dateError')      : showError('dateError',      'Please select a pickup date.');
      location  ? clearError('locationError')  : showError('locationError',  'Please choose a pickup location.');

      var hasItems = Array.from(rows).some(function(r) {
        return parseInt(r.querySelector('.qty').value) > 0;
      });
      hasItems ? clearError('itemError') : showError('itemError', 'Please add at least one item.');

      if (!valid) return;

      var total = document.getElementById('grandTotal').textContent;
      var conf  = document.getElementById('confirmation');
      conf.innerHTML =
        '<h2>Order Confirmed!</h2>' +
        '<p>Thanks, ' + firstName + '! Your pre-order of <strong>' + total + '</strong> is set for ' +
        '<strong>' + date + '</strong> at <strong>' + location + '</strong>.</p>' +
        '<p>A confirmation will be sent to <strong>' + email + '</strong>.</p>';
      conf.style.display = 'block';
      this.reset();
      rows.forEach(function(row) { row.querySelector('.line-total').textContent = '$0.00'; });
      updateSummary();
    });
 