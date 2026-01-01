// Netlify Function: /.netlify/functions/get-shipping-rates.js
// DEBUG VERSION - This will help us see what's being received

const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Parse the request body
    const requestBody = JSON.parse(event.body);
    
    // 🔍 DEBUG: Log what we received
    console.log('=== DEBUG: Request received ===');
    console.log('Full request body:', JSON.stringify(requestBody, null, 2));
    console.log('zipCode:', requestBody.zipCode);
    console.log('senderAddress:', requestBody.senderAddress);
    console.log('==============================');
    
    const { zipCode, senderAddress } = requestBody;
    
    // Validate inputs
    if (!zipCode || zipCode.length !== 5) {
      console.log('ERROR: Invalid ZIP code');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid destination ZIP code' })
      };
    }

    if (!senderAddress) {
      console.log('ERROR: No senderAddress in request');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Sender address is required' })
      };
    }

    // Validate sender address has required fields
    if (!senderAddress.zip || !senderAddress.city || !senderAddress.state) {
      console.log('ERROR: Incomplete sender address');
      console.log('Missing fields:', {
        hasZip: !!senderAddress.zip,
        hasCity: !!senderAddress.city,
        hasState: !!senderAddress.state
      });
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Incomplete sender address (need city, state, zip)' })
      };
    }

    // Your Shippo API key (stored in Netlify environment variables)
    const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
    
    if (!SHIPPO_API_KEY) {
      console.log('ERROR: No API key configured');
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Shippo API key not configured' })
      };
    }

    // Create shipment request to get rates
    const shipmentData = {
      address_from: {
        name: senderAddress.name || "Seller",
        street1: senderAddress.street1 || "123 Main St",
        city: senderAddress.city,          // ✅ Using from parameter
        state: senderAddress.state,        // ✅ Using from parameter
        zip: senderAddress.zip,            // ✅ Using from parameter
        country: "US"
      },
      address_to: {
        name: "Customer",
        street1: "123 Customer St",
        city: "Unknown",
        state: "NY",
        zip: zipCode,
        country: "US"
      },
      parcels: [
        {
          length: "12",
          width: "8",
          height: "5",
          distance_unit: "in",
          weight: "2",
          mass_unit: "lb"
        }
      ],
      async: false
    };

    console.log('Shipment data to Shippo:', JSON.stringify(shipmentData, null, 2));

    // Call Shippo API
    const response = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${SHIPPO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(shipmentData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Shippo API error:', errorText);
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to get shipping rates from Shippo' })
      };
    }

    const data = await response.json();
    
    console.log(`SUCCESS: Found ${data.rates?.length || 0} rates`);
    
    // Return the rates
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data.rates || [])
    };

  } catch (error) {
    console.error('Unexpected error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};