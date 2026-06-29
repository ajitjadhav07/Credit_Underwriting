/**
 * Microsoft Office 365 Authentication Configuration
 * Using Azure AD with passport-azure-ad strategy
 */

const passport = require('passport');
const OIDCStrategy = require('passport-azure-ad').OIDCStrategy;
const userManager = require('./user-manager');

// Validate required environment variables
const requiredEnvVars = [
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET', 
    'MICROSOFT_TENANT_ID',
    'REDIRECT_URI'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('❌ CRITICAL: Missing required environment variables:');
    missingVars.forEach(varName => console.error(`   - ${varName}`));
    console.error('\n💡 Add these in Render.com Environment Variables');
    process.exit(1);
}

// Validate REDIRECT_URI format
if (!process.env.REDIRECT_URI.startsWith('https://')) {
    console.error('❌ CRITICAL: REDIRECT_URI must start with https://');
    console.error(`   Current value: ${process.env.REDIRECT_URI}`);
    console.error('   Expected format: https://your-domain.com/auth/callback');
    process.exit(1);
}

console.log('✓ Authentication environment variables validated');
console.log(`✓ Redirect URI: ${process.env.REDIRECT_URI}`);

// Configuration for Azure AD authentication
const config = {
    identityMetadata: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/v2.0/.well-known/openid-configuration`,
    clientID: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    responseType: 'code id_token',
    responseMode: 'form_post',
    redirectUrl: process.env.REDIRECT_URI,
    allowHttpForRedirectUrl: false, // Always require HTTPS
    validateIssuer: true,
    passReqToCallback: false,
    scope: ['profile', 'email', 'openid'],
    loggingLevel: process.env.NODE_ENV === 'development' ? 'info' : 'error',
    nonceLifetime: 3600,
    nonceMaxAmount: 5,
    cookieSameSite: true,
};

// Serialize user into session
passport.serializeUser((user, done) => {
    done(null, user);
});

// Deserialize user from session
passport.deserializeUser((user, done) => {
    done(null, user);
});

// Configure passport with Azure AD strategy
try {
    passport.use(new OIDCStrategy(config, function(iss, sub, profile, accessToken, refreshToken, done) {
        console.log('🔐 Passport strategy callback invoked');
        console.log('   Issuer:', iss);
        console.log('   Subject:', sub);
        console.log('   Profile received:', !!profile);
        
        if (!profile) {
            console.error('❌ No profile received from Microsoft');
            return done(new Error("No profile received"), null);
        }
        
        if (!profile.oid) {
            console.error('❌ Authentication error: No OID found in user profile');
            console.error('   Profile keys:', Object.keys(profile));
            return done(new Error("No OID found in user profile"), null);
        }
        
        // Extract user information
        const email = (profile._json.email || profile._json.preferred_username).toLowerCase();
        
        // Check if user is whitelisted
        if (!userManager.isEmailWhitelisted(email)) {
            console.error(`❌ Unauthorized login attempt: ${email}`);
            return done(new Error(`Unauthorized. Contact administrator to get access.`), null);
        }
        
        // Get user details from whitelist
        const userDetails = userManager.getUser(email);
        
        const user = {
            id: profile.oid,
            email: email,  // Stored in lowercase
            displayName: profile.displayName,
            firstName: profile.name?.givenName,
            lastName: profile.name?.familyName,
            jobTitle: profile._json.jobTitle,
            department: profile._json.department,
            companyName: profile._json.companyName,
            role: userDetails.role,  // Add role from whitelist
            authenticatedAt: new Date().toISOString()
        };
        
        console.log(`✅ User profile extracted: ${user.email}`);
        console.log(`   Name: ${user.displayName}`);
        console.log(`   Role: ${user.role}`);
        console.log(`   OID: ${user.id}`);
        return done(null, user);
    }));
    
    console.log('✓ Passport OIDC strategy configured successfully');
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
