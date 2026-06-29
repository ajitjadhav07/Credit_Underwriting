/**
 * User Management Module
 * Handles user whitelist, roles, and permissions
 * Storage: In-memory Map + S3 JSON for persistence
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

// Initialize S3 Client
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'axis-underwriting-documents';
const USERS_FILE_KEY = 'users.json';

// Super Admin email from environment variable (normalized to lowercase)
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'nilesh@acc.ltd').toLowerCase();

// Allowed email domain
const ALLOWED_DOMAIN = '@acc.ltd';

// User roles
const ROLES = {
    SUPER_ADMIN: 'super_admin',
    ADMIN: 'admin',
    UNDERWRITER: 'underwriter',
    AUDITOR: 'auditor'
};

// In-memory user storage
const users = new Map();

/**
 * Initialize users from S3
 */
async function initializeUsers() {
    try {
        console.log('📋 Loading users from S3...');
        const usersData = await loadUsersFromS3();
        
        if (usersData && usersData.length > 0) {
            usersData.forEach(user => {
                users.set(user.email, user);
            });
            console.log(`✓ Loaded ${users.size} users from S3`);
        } else {
            console.log('ℹ️  No existing users found in S3');
        }
        
        // Always ensure super admin exists
        await ensureSuperAdminExists();
        
    } catch (err) {
        console.error('❌ Error loading users from S3:', err.message);
        // Continue with empty users map
        await ensureSuperAdminExists();
    }
}

/**
 * Ensure super admin user exists
 */
async function ensureSuperAdminExists() {
    if (!users.has(SUPER_ADMIN_EMAIL)) {
        console.log(`🔐 Creating super admin: ${SUPER_ADMIN_EMAIL}`);
        const superAdmin = {
            email: SUPER_ADMIN_EMAIL,
            role: ROLES.SUPER_ADMIN,
            created_at: new Date().toISOString(),
            created_by: 'system',
            status: 'active'
        };
        users.set(SUPER_ADMIN_EMAIL, superAdmin);
        await saveUsersToS3();
        console.log(`✓ Super admin created: ${SUPER_ADMIN_EMAIL}`);
    } else {
        console.log(`✓ Super admin exists: ${SUPER_ADMIN_EMAIL}`);
    }
}

/**
 * Load users from S3
 */
async function loadUsersFromS3() {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: USERS_FILE_KEY
        });
        
        const response = await s3Client.send(command);
        const bodyContents = await streamToString(response.Body);
        return JSON.parse(bodyContents);
    } catch (err) {
        if (err.name === 'NoSuchKey') {
            console.log('ℹ️  users.json does not exist yet');
            return [];
        }
        throw err;
    }
}

/**
 * Save users to S3
 */
async function saveUsersToS3() {
    try {
        const usersArray = Array.from(users.values());
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: USERS_FILE_KEY,
            Body: JSON.stringify(usersArray, null, 2),
            ContentType: 'application/json'
        });
        
        await s3Client.send(command);
        console.log(`✓ Saved ${usersArray.length} users to S3`);
        return true;
    } catch (err) {
        console.error('❌ Error saving users to S3:', err.message);
        throw err;
    }
}

/**
 * Helper to convert stream to string
 */
async function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
}

/**
 * Check if email is whitelisted
 */
function isEmailWhitelisted(email) {
    // Convert to lowercase for case-insensitive comparison
    return users.has(email.toLowerCase());
}

/**
 * Validate email domain
 */
function isValidEmailDomain(email) {
    return email.toLowerCase().endsWith(ALLOWED_DOMAIN);
}

/**
 * Get user by email
 */
function getUser(email) {
    // Convert to lowercase for case-insensitive lookup
    return users.get(email.toLowerCase());
}

/**
 * Get all users
 */
function getAllUsers() {
    return Array.from(users.values());
}

/**
 * Add new user
 */
async function addUser(email, role, createdBy) {
    // Normalize email to lowercase
    email = email.toLowerCase();
    createdBy = createdBy.toLowerCase();
    
    // Validate email domain
    if (!isValidEmailDomain(email)) {
        throw new Error(`Email must be from ${ALLOWED_DOMAIN} domain`);
    }
    
    // Check if user already exists
    if (users.has(email)) {
        throw new Error('User already exists');
    }
    
    // Validate role
    if (!Object.values(ROLES).includes(role)) {
        throw new Error('Invalid role');
    }
    
    // Check permissions: Admin cannot create other admins
    const creator = users.get(createdBy);
    if (creator && creator.role === ROLES.ADMIN && role === ROLES.ADMIN) {
        throw new Error('Admins cannot create other admins');
    }
    
    // Create new user
    const newUser = {
        email: email,
        role: role,
        created_at: new Date().toISOString(),
        created_by: createdBy,
        status: 'active'
    };
    
    users.set(email, newUser);
    await saveUsersToS3();
    
    console.log(`✓ User added: ${email} (${role})`);
    return newUser;
}

/**
 * Delete user
 */
async function deleteUser(email, deletedBy) {
    // Normalize email to lowercase
    email = email.toLowerCase();
    
    // Cannot delete super admin
    if (email === SUPER_ADMIN_EMAIL.toLowerCase()) {
        throw new Error('Cannot delete super admin');
    }
    
    // Check if user exists
    if (!users.has(email)) {
        throw new Error('User not found');
    }
    
    users.delete(email);
    await saveUsersToS3();
    
    console.log(`✓ User deleted: ${email}`);
    return true;
}

/**
 * Update user role
 */
async function updateUserRole(email, newRole, updatedBy) {
    // Normalize emails to lowercase
    email = email.toLowerCase();
    updatedBy = updatedBy.toLowerCase();
    
    // Cannot update super admin
    if (email === SUPER_ADMIN_EMAIL.toLowerCase()) {
        throw new Error('Cannot modify super admin');
    }
    
    // Check if user exists
    const user = users.get(email);
    if (!user) {
        throw new Error('User not found');
    }
    
    // Validate role
    if (!Object.values(ROLES).includes(newRole)) {
        throw new Error('Invalid role');
    }
    
    // Check permissions: Admin cannot create other admins
    const updater = users.get(updatedBy);
    if (updater && updater.role === ROLES.ADMIN && newRole === ROLES.ADMIN) {
        throw new Error('Admins cannot promote users to admin');
    }
    
    user.role = newRole;
    user.updated_at = new Date().toISOString();
    user.updated_by = updatedBy;
    
    users.set(email, user);
    await saveUsersToS3();
    
    console.log(`✓ User role updated: ${email} -> ${newRole}`);
    return user;
}

/**
 * Check if user has permission
 */
function hasPermission(userEmail, requiredRoles) {
    const user = users.get(userEmail.toLowerCase());
    if (!user) return false;
    
    return requiredRoles.includes(user.role);
}

/**
 * Check if user can manage other users
 */
function canManageUsers(userEmail) {
    const user = users.get(userEmail.toLowerCase());
    if (!user) return false;
    
    return user.role === ROLES.SUPER_ADMIN || user.role === ROLES.ADMIN;
}

/**
 * Check if user can see all cases
 */
function canSeeAllCases(userEmail) {
    const user = users.get(userEmail.toLowerCase());
    if (!user) return false;
    
    return user.role === ROLES.SUPER_ADMIN || user.role === ROLES.AUDITOR;
}

/**
 * Check if user is read-only
 */
function isReadOnly(userEmail) {
    const user = users.get(userEmail.toLowerCase());
    if (!user) return true;
    
    return user.role === ROLES.AUDITOR;
}

module.exports = {
    ROLES,
    SUPER_ADMIN_EMAIL,
    ALLOWED_DOMAIN,
    initializeUsers,
    isEmailWhitelisted,
    isValidEmailDomain,
    getUser,
    getAllUsers,
    addUser,
    deleteUser,
    updateUserRole,
    hasPermission,
    canManageUsers,
    canSeeAllCases,
    isReadOnly
};
