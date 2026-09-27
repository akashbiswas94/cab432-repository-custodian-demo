# Authentication

TaskFlow uses bearer-token authentication.

Users authenticate through the login service and receive an access token.

The token should be sent with API requests using:

Authorization: Bearer <token>

## Token Expiry

Access tokens are valid for 60 minutes.

When a token expires, the API should return HTTP 401 and the client should request a new authentication token.

## Known Issue

Token expiry handling is currently incomplete.

Some requests may fail unexpectedly when an expired token is supplied.