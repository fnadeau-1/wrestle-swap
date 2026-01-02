const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { zipCode, senderAddress } = JSON.parse(event.body);
    
    console.log('Request received:', { zipCode, senderAddress });
    
    if (!zipCode || zipCode.length !== 5) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid ZIP code' })
      };
    }

    if (!senderAddress || !senderAddress.zip || !senderAddress.city || !senderAddress.state) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Sender address required' })
      };
    }

    const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;
    
    if (!SHIPPO_API_KEY) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'API key not configured' })
      };
    }

    const shipmentData = {
      address_from: {
        name: senderAddress.name || "Seller",
        street1: senderAddress.street1 || "123 Main St",
        city: senderAddress.city,
        state: senderAddress.state,
        zip: senderAddress.zip,
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
      parcels: [{
        length: "12",
        width: "8",
        height: "5",
        distance_unit: "in",
        weight: "2",
        mass_unit: "lb"
      }],
      async: false
    };

    console.log('Calling Shippo API...');

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
      console.error('Shippo error:', errorText);
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to get rates' })
      };
    }

    const data = await response.json();
    console.log(`Success: Found ${data.rates?.length || 0} rates`);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data.rates || [])
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};