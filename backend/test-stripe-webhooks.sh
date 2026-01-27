#!/bin/bash

# A script to automate testing of Stripe webhooks.
# It starts the stripe listener, extracts the webhook secret,
# and then runs the trigger commands.

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# --- 1. Check for Stripe CLI login ---
echo "Checking Stripe CLI login status..."
if ! stripe customers list --limit 1 &> /dev/null; then
  echo -e "${RED}You are not logged into the Stripe CLI. Please run 'stripe login' first and then re-run this script.${NC}"
  exit 1
fi
echo -e "${GREEN}Stripe CLI is logged in.${NC}\n"

# --- 2. Start Stripe listener and get webhook secret ---
echo "Starting Stripe webhook listener..."
stripe listen --forward-to localhost:4242/webhooks/stripe > stripe_listen.log 2>&1 &
STRIPE_LISTEN_PID=$!

# Kill the listener on script exit
trap 'kill $STRIPE_LISTEN_PID' EXIT

echo "Waiting for webhook secret..."
sleep 5 # Give it a moment to initialize

WEBHOOK_SECRET=$(grep -o 'whsec_[^[:space:]]*' stripe_listen.log)

if [ -z "$WEBHOOK_SECRET" ]; then
  echo -e "${RED}Could not find webhook secret. Check stripe_listen.log for errors.${NC}"
  exit 1
fi

echo -e "${GREEN}Webhook secret found: $WEBHOOK_SECRET${NC}\n"

# --- 3. Update .env file ---
echo "Updating .env file with the new webhook secret..."
# Create .env if it doesn't exist
touch .env
# Remove old webhook secret and add the new one
sed -i '/STRIPE_WEBHOOK_SECRET/d' .env
echo "STRIPE_WEBHOOK_SECRET=$WEBHOOK_SECRET" >> .env
echo -e "${GREEN}.env file updated successfully.${NC}\n"

echo "Now, please start your server in another terminal with 'npm run dev'."
echo "Press any key to continue with the tests once the server is running..."
read -n 1 -s

# --- 4. Run tests ---
run_test() {
  echo "Running test: $1"
  if eval "$1"; then
    echo -e "${GREEN}SUCCESS: $1${NC}"
  else
    echo -e "${RED}FAILURE: $1${NC}"
  fi
  echo ""
}

run_test "stripe trigger payment_intent.succeeded"
run_test "stripe trigger account.updated"
run_test "stripe trigger charge.refunded"
run_test "stripe trigger invoice.paid"
run_test "stripe trigger customer.subscription.created"

echo "All tests completed."

# The 'trap' will automatically kill the stripe listen process on exit.