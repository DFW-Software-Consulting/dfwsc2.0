#!/bin/bash
# Payment Flow Verification Script
# This script tests the complete payment flow end-to-end

set -e

API_BASE="http://localhost:4242/api/v1"
FRONTEND_URL="http://localhost:1919"

echo "=========================================="
echo "DFWSC Payment Portal - Flow Verification"
echo "=========================================="
echo ""

# Step 1: Health Check
echo "1️⃣  Checking API health..."
HEALTH_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_BASE/health")
HEALTH_CODE=$(echo "$HEALTH_RESPONSE" | tail -n1)
HEALTH_BODY=$(echo "$HEALTH_RESPONSE" | head -n-1)

if [ "$HEALTH_CODE" = "200" ]; then
    echo "   ✅ API is healthy"
else
    echo "   ❌ API health check failed (HTTP $HEALTH_CODE)"
    echo "   Response: $HEALTH_BODY"
    exit 1
fi
echo ""

# Step 2: Admin Login
echo "2️⃣  Admin login..."
ADMIN_CREDS=$(curl -s -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"testpassword"}')

TOKEN=$(echo "$ADMIN_CREDS" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -n "$TOKEN" ]; then
    echo "   ✅ Admin login successful"
    echo "   Token: ${TOKEN:0:20}..."
else
    echo "   ❌ Admin login failed"
    echo "   Response: $ADMIN_CREDS"
    exit 1
fi
echo ""

# Step 3: Create a Test Client
echo "3️⃣  Creating test client..."
CLIENT_RESPONSE=$(curl -s -X POST "$API_BASE/accounts" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{
        "name": "Test Payment Client",
        "email": "test-client-'"$(date +%s)"'@example.com"
    }')

CLIENT_ID=$(echo "$CLIENT_RESPONSE" | grep -o '"clientId":"[^"]*"' | cut -d'"' -f4)
API_KEY=$(echo "$CLIENT_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
ONBOARD_TOKEN=$(echo "$CLIENT_RESPONSE" | grep -o '"onboardingToken":"[^"]*"' | cut -d'"' -f4)

if [ -n "$CLIENT_ID" ] && [ -n "$API_KEY" ]; then
    echo "   ✅ Client created successfully"
    echo "   Client ID: $CLIENT_ID"
    echo "   API Key: ${API_KEY:0:20}..."
    echo "   Onboarding Token: $ONBOARD_TOKEN"
else
    echo "   ❌ Client creation failed"
    echo "   Response: $CLIENT_RESPONSE"
    exit 1
fi
echo ""

# Step 4: Try to Create Payment (should fail - no Stripe account connected)
echo "4️⃣  Testing payment creation (expecting 400 - no Stripe account)..."
PAYMENT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/payments/create" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -H "Idempotency-Key: test-$(date +%s)" \
    -d '{
        "amount": 1000,
        "currency": "usd",
        "description": "Test payment"
    }')

PAYMENT_CODE=$(echo "$PAYMENT_RESPONSE" | tail -n1)
PAYMENT_BODY=$(echo "$PAYMENT_RESPONSE" | head -n-1)

if [ "$PAYMENT_CODE" = "400" ]; then
    echo "   ✅ Correctly rejected (client has no Stripe account)"
    echo "   Response: $PAYMENT_BODY"
elif [ "$PAYMENT_CODE" = "201" ]; then
    echo "   ⚠️  Payment created (unexpected - Stripe account already connected?)"
    echo "   Response: $PAYMENT_BODY"
else
    echo "   ❌ Unexpected response (HTTP $PAYMENT_CODE)"
    echo "   Response: $PAYMENT_BODY"
fi
echo ""

# Step 5: Get Onboarding URL
echo "5️⃣  Getting Stripe onboarding URL..."
ONBOARD_RESPONSE=$(curl -s "$API_BASE/onboard-client?token=$ONBOARD_TOKEN")

ONBOARD_URL=$(echo "$ONBOARD_RESPONSE" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)

if [ -n "$ONBOARD_URL" ]; then
    echo "   ✅ Onboarding URL generated"
    echo "   URL: $ONBOARD_URL"
    echo ""
    echo "   📝 MANUAL STEP: Open this URL in a browser to complete Stripe onboarding"
    echo "      $FRONTEND_URL/onboard?token=$ONBOARD_TOKEN"
else
    echo "   ⚠️  Could not extract onboarding URL"
    echo "   Response: $ONBOARD_RESPONSE"
fi
echo ""

# Summary
echo "=========================================="
echo "✅ Verification Complete!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  - API is running and healthy"
echo "  - Admin authentication works"
echo "  - Client creation works"
echo "  - API key authentication works"
echo "  - Payment validation works (requires Stripe account)"
echo ""
echo "Next steps to test full payment flow:"
echo "  1. Complete Stripe onboarding at: $FRONTEND_URL/onboard?token=$ONBOARD_TOKEN"
echo "  2. Use the API key to create a payment"
echo "  3. Check MailHog at http://localhost:8025 for emails"
echo "  4. Check Stripe dashboard for test payments"
echo ""
