#!/usr/bin/env bash
# Simulate main Stripe events for webhook testing

# Function to run and check stripe trigger commands
run_trigger() {
    printf "⏳  Triggering event: %-35s" "$1"
    if output=$(stripe trigger "$1" $2 2>&1); then
        echo "✅  Success"
    else
        echo "❌  Failed"
        echo "================================================================================"
        echo "Error details for: $1"
        echo "================================================================================"
        echo "$output"
        echo "================================================================================"
        echo
    fi
}

echo "---[ Testing Platform Events ]---"
echo
run_trigger "payment_intent.succeeded"
run_trigger "payment_intent.payment_failed"
run_trigger "charge.refunded"
run_trigger "checkout.session.completed"
echo

echo "---[ Testing Connected Account Events ]---"
echo

# IMPORTANT: Replace with a real test Connect account ID from your Stripe dashboard
# You can create one by running through your Connect onboarding flow in test mode.
CONNECTED_ACCT="acct_123456789"

if [[ -z "$CONNECTED_ACCT" || "$CONNECTED_ACCT" == "acct_123456789" ]]; then
    echo "⚠️  Skipping connected account tests."
    echo "    Please edit this script and replace 'acct_123456789' with a real test account ID."
    echo
else
    run_trigger "payment_intent.succeeded" "--stripe-account $CONNECTED_ACCT"
    run_trigger "charge.refunded" "--stripe-account $CONNECTED_ACCT"
    run_trigger "account.updated" "--stripe-account $CONNECTED_ACCT"
fi

echo "🎉 All Stripe test events triggered."