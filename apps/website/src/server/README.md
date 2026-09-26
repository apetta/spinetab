# Demo backend

Future live demo endpoints belong here, beside the website. There is no backend
implementation yet. Static data and browser-only examples need no live endpoint.

The current website build is entirely static; placing a file here does not create
a route. Choose an appropriate runtime when live endpoints are implemented. Their
source stays in this workspace even if the static site and endpoints are deployed
separately. No hosting provider or adapter is required by the scaffold.

Keep fault injection in the library's private test fixtures. Public demo controls
must be scoped to the visitor's session with bounded usage, and must not expose
secrets or a general-purpose relay. These endpoints are not a published server
package or a backend that consumers must adopt.
