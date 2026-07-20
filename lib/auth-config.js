/**
 * AFL ADFS Authentication Configuration
 * Using SAML 2.0 against AFL's on-prem ADFS server (adfsuat.axisb.com)
 *
 * Replaces the earlier Azure Entra ID / OIDC login. Config values below
 * come directly from AFL's ADFS Federation Metadata
 * (https://adfsuat.axisb.com/FederationMetadata/2007-06/FederationMetadata.xml)
 * and the signed ADFS onboarding template, not guessed defaults.
 */

const passport = require('passport');
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const userManager = require('./user-manager');

// Validate required environment variables
const requiredEnvVars = [
    'ADFS_SSO_URL',
    'ADFS_ENTITY_ID',
    'ADFS_SIGNING_CERT',
    'ADFS_SP_ENTITY_ID',
    'ADFS_CALLBACK_URL'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('❌ CRITICAL: Missing required environment variables:');
    missingVars.forEach(varName => console.error(`   - ${varName}`));
    process.exit(1);
}

if (!process.env.ADFS_CALLBACK_URL.startsWith('https://')) {
    console.error('❌ CRITICAL: ADFS_CALLBACK_URL must start with https://');
    console.error(`   Current value: ${process.env.ADFS_CALLBACK_URL}`);
    process.exit(1);
}

console.log('✓ ADFS authentication environment variables validated');
console.log(`✓ ACS callback URL: ${process.env.ADFS_CALLBACK_URL}`);

// AFL's ADFS well-known claim URI for email — confirmed from Federation
// Metadata's ClaimTypesOffered / IDPSSODescriptor Attribute list.
const EMAIL_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
const NAME_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name';
const GIVENNAME_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname';
const SURNAME_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname';
const UPN_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn';

const samlConfig = {
    entryPoint: process.env.ADFS_SSO_URL,           // https://adfsuat.axisb.com/adfs/ls/
    issuer: process.env.ADFS_SP_ENTITY_ID,           // https://aflcuwuat.axisb.com (our Realm Identifier)
    idpIssuer: process.env.ADFS_ENTITY_ID,           // http://adfsuat.axisb.com/adfs/services/trust
    callbackUrl: process.env.ADFS_CALLBACK_URL,      // https://aflcuwuat.axisb.com/auth/saml/callback
    idpCert: process.env.ADFS_SIGNING_CERT,          // ADFS token-signing certificate (PEM, no header/footer needed)
    wantAssertionsSigned: true,
    // ADFS signs the inner Assertion, not the outer Response element (its
    // standard default behavior) -- explicitly false here so the library
    // doesn't reject a validly-signed assertion just because the Response
    // wrapper itself isn't separately signed. Confirmed via a real login
    // attempt (2026-07-10 08:18 UTC): "Invalid document signature" was
    // being thrown by the library's Response-level check, before it ever
    // got to verifying the Assertion's own (valid) signature.
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    // Deliberately null, not a specific format like emailAddress. ADFS
    // rejected the SAML 1.1 emailAddress NameIDPolicy with
    // InvalidNameIDPolicy (this Relying Party Trust isn't configured to
    // honor that specific format). Setting this to null omits the Format
    // attribute entirely, letting ADFS issue whatever NameID format it
    // wants -- safe here because the email is read from the attribute
    // claim (EMAIL_CLAIM below), not from NameID, so we don't actually
    // need to dictate its format.
    identifierFormat: null,
    // ADFS stamps each assertion with NotBefore / NotOnOrAfter timestamps.
    // If the container clock differs even slightly from ADFS's clock, a
    // valid assertion gets rejected with "SAML assertion not yet valid"
    // (NotBefore is a few seconds in the future relative to our clock).
    // Allow 5 minutes of skew in either direction — the standard tolerance
    // for SAML — so minor clock drift doesn't break login.
    acceptedClockSkewMs: 300000,
};

// Serialize user into session
passport.serializeUser((user, done) => {
    done(null, user);
});

// Deserialize user from session
passport.deserializeUser((user, done) => {
    done(null, user);
});

// Configure passport with ADFS SAML strategy
try {
    passport.use('adfs-saml', new SamlStrategy(samlConfig, function(profile, done) {
        console.log('🔐 SAML strategy callback invoked');

        if (!profile) {
            console.error('❌ No profile received from ADFS');
            return done(new Error('No profile received'), null);
        }

        // AFL's ADFS currently releases ONLY the empId claim (e.g. "AFL2631"),
        // not the email address, even though the onboarding form requested
        // email. So we accept whichever identifier the assertion actually
        // provides, in priority order: email claim -> empId claim -> nameID.
        // Whatever we resolve here is what the whitelist is matched against,
        // so the SUPER_ADMIN_EMAIL / user list must contain the SAME kind of
        // value ADFS sends (today: the empId, e.g. "AFL2631"). If AFL later
        // starts releasing the email claim, email takes priority automatically
        // and no code change is needed.
        const emailClaim = (profile[EMAIL_CLAIM] || '').toLowerCase();
        const empId = (profile.empId || '').toString().toLowerCase();
        const identifier = emailClaim || empId || (profile.nameID || '').toLowerCase();

        if (!identifier) {
            console.error('❌ Authentication error: no usable identifier (email/empId/nameID) in SAML assertion');
            console.error('   Claims received:', Object.keys(profile));
            return done(new Error('No usable identifier found in SAML assertion'), null);
        }

        console.log(`🔎 Resolved login identifier: ${identifier} (source: ${emailClaim ? 'email' : empId ? 'empId' : 'nameID'})`);

        // Check if identifier is whitelisted
        if (!userManager.isEmailWhitelisted(identifier)) {
            console.error(`❌ Unauthorized login attempt: ${identifier}`);
            return done(new Error('Unauthorized. Contact administrator to get access.'), null);
        }

        // Get user details from whitelist
        const userDetails = userManager.getUser(identifier);

        const user = {
            id: profile.nameID || identifier,
            email: emailClaim || identifier,  // real email if present, else the identifier
            empId: profile.empId || null,
            displayName: profile[NAME_CLAIM] || identifier,
            firstName: profile[GIVENNAME_CLAIM],
            lastName: profile[SURNAME_CLAIM],
            upn: profile[UPN_CLAIM],
            role: userDetails.role,  // Add role from whitelist
            authenticatedAt: new Date().toISOString()
        };

        console.log(`✅ User profile extracted: ${user.email}`);
        console.log(`   Name: ${user.displayName}`);
        console.log(`   Role: ${user.role}`);
        return done(null, user);
    }));

    console.log('✓ Passport ADFS SAML strategy configured successfully');
} catch (err) {
    console.error('❌ CRITICAL: Failed to configure passport strategy:', err.message);
    console.error('   Stack:', err.stack);
    throw err;
}

// Middleware to check if user is authenticated
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    // Save the original URL they were trying to access
    req.session.returnTo = req.originalUrl;
    console.log(`⚠️  Unauthenticated access attempt to: ${req.originalUrl}`);
    res.redirect('/login');
}

// Middleware to check if already authenticated (for login page)
function ensureNotAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return res.redirect('/');
    }
    next();
}

// Middleware to require specific roles
function requireRole(...allowedRoles) {
    return function(req, res, next) {
        if (!req.isAuthenticated()) {
            req.session.returnTo = req.originalUrl;
            return res.redirect('/login');
        }
        
        const userRole = req.user?.role;
        if (!userRole || !allowedRoles.includes(userRole)) {
            console.log(`⚠️  Forbidden: User ${req.user?.email} (${userRole}) attempted to access ${req.originalUrl}`);
            return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
        }
        
        next();
    };
}

// Middleware to block auditors from making changes
function ensureNotReadOnly(req, res, next) {
    if (!req.isAuthenticated()) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/login');
    }
    
    if (userManager.isReadOnly(req.user.email)) {
        console.log(`⚠️  Read-only user ${req.user.email} attempted to modify data`);
        return res.status(403).json({ error: 'Forbidden: Read-only access' });
    }
    
    next();
}

module.exports = {
    passport,
    ensureAuthenticated,
    ensureNotAuthenticated,
    requireRole,
    ensureNotReadOnly,
    ROLES: userManager.ROLES
};
