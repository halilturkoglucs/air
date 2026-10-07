# Security policy

AIR is pre-1.0 experimental software. Do not use generated applications with production data until their generated code, authentication mapping, database privileges, migrations, and deployment configuration have been independently reviewed.

Report suspected vulnerabilities through [GitHub's private security advisory form](https://github.com/halilturkoglucs/air/security/advisories/new). Include the affected AIR version, target, a minimal reproducer, and impact. Do not open a public issue containing credentials, exploitable production details, or customer data.

Only the current minor release line receives security fixes. Generated projects pin dependencies, but adopters remain responsible for dependency scanning and timely regeneration.

AIR verification establishes behavioral agreement for declared semantics; it is not a security audit. In particular, custom user-owned code beyond the adoption boundary is outside compiler verification.
