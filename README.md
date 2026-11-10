# VeloraPanel setup
1. `npm i -g firebase-tools && firebase login && firebase use velorapanel`
2. Enable Google sign-in + create Firestore in project **velorapanel**; upgrade to Blaze (needed for Cloud Functions).
3. Firebase console → project **velora-5246f** (the game) → Project settings → Service accounts → "Generate new private key".
4. `firebase functions:secrets:set VELORA_SERVICE_ACCOUNT` → paste the whole JSON of that key.
5. `cd functions && npm install && cd ..`
6. `firebase deploy`
