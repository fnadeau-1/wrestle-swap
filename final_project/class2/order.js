document.addEventListener('DOMContentLoaded', function () {
  const form = document.querySelector('#orderForm');
  const rows = document.querySelectorAll('.order-row');

  const subtotalEl = document.querySelector('#subtotal');
  const taxEl = document.querySelector('#tax');
  const grandTotalEl = document.querySelector('#grandTotal');
  const confirmation = document.querySelector('#confirmation');

  function clearErrors() {
    document.querySelector('#firstNameError').textContent = '';
    document.querySelector('#lastNameError').textContent = '';
    document.querySelector('#emailError').textContent = '';
    document.querySelector('#dateError').textContent = '';
    document.querySelector('#locationError').textContent = '';
    document.querySelector('#itemError').textContent = '';


    confirmation.textContent = '';
  }

  function calculateTotals() {
    let subtotal = 0;

    rows.forEach(function (row) {
      const price = Number(row.dataset.price);
      const qtyInput = row.querySelector('.qty');
      const lineTotalEl = row.querySelector('.line-total');

      let quantity = Number(qtyInput.value);

      if (qtyInput.value === '' || quantity < 0 || !Number.isInteger(quantity)) {
        quantity = 0;
      }

      const lineTotal = price * quantity;

      if (quantity > 0) {
        row.classList.add('active');
      } else {
        row.classList.remove('active');
      }

      lineTotalEl.textContent = '$' + lineTotal.toFixed(2);
      subtotal += lineTotal;
    });

    const tax = subtotal * 0.08;
    const grandTotal = subtotal + tax;

    subtotalEl.textContent = '$' + subtotal.toFixed(2);
    taxEl.textContent = '$' + tax.toFixed(2);
    grandTotalEl.textContent = '$' + grandTotal.toFixed(2);
  }

  rows.forEach(function (row) {
    const qtyInput = row.querySelector('.qty');

    qtyInput.addEventListener('focus', function () {
      if (this.value === '0') {
        this.value = '';
      }
    });

    qtyInput.addEventListener('input', function () {
      calculateTotals();
    });

    qtyInput.addEventListener('blur', function () {
      if (this.value === '') {
        this.value = 0;
      }
      calculateTotals();
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();

    let isValid = true;
    let hasItem = false;

    const firstName = document.querySelector('#firstName');
    const lastName = document.querySelector('#lastName');
    const email = document.querySelector('#email');
    const pickupDate = document.querySelector('#pickupDate');
    const pickupLocation = document.querySelector('#pickupLocation');

    if (firstName.value.trim() === '') {
      document.querySelector('#firstNameError').textContent = 'First name is required.';
      isValid = false;
    }

    if (lastName.value.trim() === '') {
      document.querySelector('#lastNameError').textContent = 'Last name is required.';
      isValid = false;
    }

    if (email.value.trim() === '') {
      document.querySelector('#emailError').textContent = 'Email is required.';
      isValid = false;
    }

    if (pickupDate.value === '') {
      document.querySelector('#dateError').textContent = 'Pickup date is required.';
      isValid = false;
    }

    if (pickupLocation.value === '') {
      document.querySelector('#locationError').textContent = 'Pickup location is required.';
      isValid = false;
    }

    rows.forEach(function (row) {
      const qtyInput = row.querySelector('.qty');
      const quantity = Number(qtyInput.value);

      if (quantity > 0) {
        hasItem = true;
      }

      if (qtyInput.value === '' || quantity < 0 || !Number.isInteger(quantity)) {
        document.querySelector('#itemError').textContent =
          'Quantities must be positive whole numbers.';
        isValid = false;
      }
    });

    if (!hasItem) {
      document.querySelector('#itemError').textContent =
        'Please select at least one product.';
      isValid = false;
    }

    calculateTotals();

    if (isValid) {
      
      confirmation.textContent = '';

      
      const title = document.createElement('h2');
      title.textContent = 'Order Confirmed!';

      const message = document.createElement('p');
      message.textContent = `Thank you, ${firstName.value} ${lastName.value}. Your pre-order has been received.`;

      const location = document.createElement('p');
      location.textContent = `Pickup Location: ${pickupLocation.value}`;

      const date = document.createElement('p');
      date.textContent = `Pickup Date: ${pickupDate.value}`;

      const total = document.createElement('p');
      total.textContent = `Your grand total is ${grandTotalEl.textContent}.`;

      
      confirmation.appendChild(title);
      confirmation.appendChild(message);
      confirmation.appendChild(location);
      confirmation.appendChild(date);
      confirmation.appendChild(total);
    }
  });

  calculateTotals();
}); 
