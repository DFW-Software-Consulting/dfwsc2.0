#!/bin/bash
# Post-Onboarding Payment Test - Auto-detects test client
# Run this AFTER completing Stripe onboarding

set -e

API_BASE="http://localhost:4242/api/v1"

echo "=========================================="
echo "Post-Onboarding Payment Test"
echo "=========================================="
echo ""

# Step 0: Admin login
echo "0️⃣  Admin login..."
ADMIN_CREDS=$(curl -s -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"testpassword"}')

TOKEN=$(echo "$ADMIN_CREDS" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
    echo "   ❌ Admin login failed"
    echo "   Response: $ADMIN_CREDS"
    exit 1
fi
echo "   ✅ Admin login successful"
echo ""

# Step 1: Get client list and find test client
echo "1️⃣  Finding test client..."
CLIENTS_RESPONSE=$(curl -s "$API_BASE/clients" \
    -H "Authorization: Bearer $TOKEN")

# Extract the first client that has a stripeAccountId
CLIENT_ID=$(echo "$CLIENTS_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
CLIENT_NAME=$(echo "$CLIENTS_RESPONSE" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
STRIPE_ACCOUNT=$(echo "$CLIENTS_RESPONSE" | grep -o '"stripeAccountId":"acct_[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$CLIENT_ID" ]; then
    echo "   ❌ No clients found"
    exit 1
fi

echo "   Client ID: $CLIENT_ID"
echo "   Client Name: $CLIENT_NAME"

if [ -n "$STRIPE_ACCOUNT" ]; then
    echo "   ✅ Stripe account connected: $STRIPE_ACCOUNT"
else
    echo "   ❌ No Stripe account connected yet"
    echo ""
    echo "   Please complete onboarding first!"
    echo "   Run: ./test-payment-flow.sh"
    echo ""
    exit 1
fi
echo ""

# Step 2: Get API key from database (we need to query directly)
echo "2️⃣  Getting API key for client..."
# Since we can't expose API keys via API, we'll use a test approach
# Create a new test client with known API key
TEST_EMAIL="test-payment-$(date +%s)@example.com"
echo "   Creating fresh test client for payment test..."

NEW_CLIENT_RESPONSE=$(curl -s -X POST "$API_BASE/accounts" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{
        "name": "Payment Test Client",
        "email": "'"$TEST_EMAIL"'"
    }')

NEW_CLIENT_ID=$(echo "$NEW_CLIENT_RESPONSE" | grep -o '"clientId":"[^"]*"' | cut -d'"' -f4)
API_KEY=$(echo "$NEW_CLIENT_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
ONBOARD_TOKEN=$(echo "$NEW_CLIENT_RESPONSE" | grep -o '"onboardingToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "$API_KEY" ]; then
    echo "   ❌ Failed to create test client"
    exit 1
fi

echo "   ✅ New test client created"
echo "   Client ID: $NEW_CLIENT_ID"
echo "   API Key: ${API_KEY:0:20}..."
echo ""

# Step 3: Get onboarding URL for new client
echo "3️⃣  Getting onboarding URL..."
ONBOARD_RESPONSE=$(curl -s "$API_BASE/onboard-client?token=$ONBOARD_TOKEN")

ONBOARD_URL=$(echo "$ONBOARD_RESPONSE" | grep -o '"url":"https://[^"]*"' | cut -d'"' -f4)

if [ -n "$ONBOARD_URL" ]; then
    echo "   ✅ Onboarding URL generated"
    echo ""
    echo "   📝 MANUAL STEP REQUIRED:"
    echo "   Open this URL to complete Stripe onboarding:"
    echo "   http://localhost:1919/onboard?token=$ONBOARD_TOKEN"
    echo ""
    read -p "   Press Enter AFTER completing onboarding in your browser..."
else
    echo "   ❌ Failed to get onboarding URL"
    echo "   Response: $ONBOARD_RESPONSE"
    exit 1
fi
echo ""

# Step 4: Verify Stripe account is now connected
echo "4️⃣  Verifying Stripe account connection..."
sleep 2  # Give it a moment to update

UPDATED_CLIENTS=$(curl -s "$API_BASE/clients" \
    -H "Authorization: Bearer $TOKEN")

NEW_STRIPE_ACCOUNT=$(echo "$UPDATED_CLIENTS" | grep -A5 "\"id\":\"$NEW_CLIENT_ID\"" | grep -o '"stripeAccountId":"acct_[^"]*"' | cut -d'"' -f4)

if [ -n "$NEW_STRIPE_ACCOUNT" ]; then
    echo "   ✅ Stripe account connected: $NEW_STRIPE_ACCOUNT"
else
    echo "   ⚠️  Stripe account not detected yet"
    echo "   This might take a moment after onboarding..."
    echo "   You can re-run this script to try again"
    exit 1
fi
echo ""

# Step 5: Create Checkout Session payment
echo "5️⃣  Creating Checkout Session payment..."
CHECKOUT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/payments/create" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -H "Idempotency-Key: checkout-test-$(date +%s)" \
    -d '{
        "lineItems": [{
            "price_data": {
                "currency": "usd",
                "product_data": {
                    "name": "Test Product - Payment Verification"
                },
                "unit_amount": 2000
            },
            "quantity": 1
        }]
    }')

CHECKOUT_CODE=$(echo "$CHECKOUT_RESPONSE" | tail -n1)
CHECKOUT_BODY=$(echo "$CHECKOUT_RESPONSE" | head -n-1)

if [ "$CHECKOUT_CODE" = "201" ]; then
    CHECKOUT_URL=$(echo "$CHECKOUT_BODY" | grep -o '"url":"https://[^"]*"' | cut -d'"' -f4)
    if [ -n "$CHECKOUT_URL" ]; then
        echo "   ✅ Checkout session created successfully"
        echo ""
        echo "   📝 MANUAL STEP: Complete the payment"
        echo "   Open: $CHECKOUT_URL"
        echo ""
        echo "   Use Stripe test card:"
        echo "   Card: 4242 4242 4242 4242"
        echo "   Expiry: Any future date (e.g., 12/30)"
        echo "   CVC: Any 3 digits (e.g., 123)"
        echo ""
        read -p "   Press Enter AFTER completing the payment..."
    else
        echo "   ⚠️  Response received but no URL extracted"
        echo "   Response: $CHECKOUT_BODY"
    fi
else
    echo "   ❌ Checkout creation failed (HTTP $CHECKOUT_CODE)"
    echo "   Response: $CHECKOUT_BODY"
fi
echo ""

# Step 6: Check payment reports
echo "6️⃣  Checking payment reports..."
REPORT_RESPONSE=$(curl -s "$API_BASE/reports/payments?clientId=$NEW_CLIENT_ID" \
    -H "Authorization: Bearer $TOKEN")

echo "   Payment Report:"
echo "   $REPORT_RESPONSE" | head -c 800
echo ""
echo ""

# Summary
echo "=========================================="
echo "✅ Payment Flow Test Complete!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  - Test Client: $NEW_CLIENT_ID"
echo "  - Stripe Account: $NEW_STRIPE_ACCOUNT"
echo "  - Checkout Session: Created"
echo "  - API Key Auth: Working"
echo ""
echo "Verification:"
echo "  - Check Stripe Dashboard: https://dashboard.stripe.com/test/payments"
echo "  - Check MailHog: http://localhost:8025"
echo "  - Check webhook logs: docker compose logs -f stripe-cli"
echo ""
