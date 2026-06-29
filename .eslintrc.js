/**
 * ESLint Configuration - Security Focused
 * 
 * This configuration is used by the compliance scanner
 * to detect security vulnerabilities in code.
 */

module.exports = {
    env: {
        node: true,
        es2021: true
    },
    parserOptions: {
        ecmaVersion: 2021
    },
    plugins: ['security'],
    extends: [
        'eslint:recommended'
    ],
    rules: {
        // ==================== SECURITY RULES ====================
        // These rules detect common security vulnerabilities
        
        // Detect eval() with expressions (Code Injection)
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
        
        // Detect unsafe regex (ReDoS)
        'no-control-regex': 'error',
        'no-invalid-regexp': 'error',
        
        // Prevent prototype pollution
        'no-proto': 'error',
        'no-extend-native': 'error',
        
        // Prevent information leakage
        'no-console': 'off', // We use console for server logging
        
        // ==================== CODE QUALITY ====================
        'no-unused-vars': ['warn', { 
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_'
        }],
        'no-undef': 'error',
        'no-unreachable': 'error',
        'no-constant-condition': 'warn',
        
        // ==================== BEST PRACTICES ====================
        'eqeqeq': ['warn', 'smart'],
        'no-var': 'warn',
        'prefer-const': 'warn'
    },
    overrides: [
        {
            // Relax rules for config files
            files: ['*.config.js', 'tailwind.config.js'],
            rules: {
                'no-unused-vars': 'off'
            }
        }
    ],
    ignorePatterns: [
        'node_modules/',
        'public/styles.css',
        'compliance/',
        '*.min.js'
    ]
};
