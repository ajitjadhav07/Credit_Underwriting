/**
 * DOCX Report Generator
 * Generates comprehensive credit assessment reports in Word format
 * v2 - Compact layout with no empty spaces
 */

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, 
        Header, Footer, AlignmentType, BorderStyle, WidthType, 
        HeadingLevel, ShadingType, PageNumber, PageBreak, LevelFormat } = require('docx');

class DocxGenerator {
    constructor() {
        this.COLOR_PRIMARY = '1e40af';
        this.COLOR_SUCCESS = '16a34a';
        this.COLOR_DANGER = 'dc2626';
        this.COLOR_WARNING = 'ea580c';
        this.COLOR_HEADER_BG = 'E8F4FC';
        this.tableBorder = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
    }

    // Sanitize text to remove invalid XML characters
    sanitizeText(text) {
        if (text === null || text === undefined) return '-';
        if (typeof text === 'number') {
            if (isNaN(text) || !isFinite(text)) return '-';
            return String(text);
        }
        // Remove invalid XML characters (control chars except tab, newline, carriage return)
        return String(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    }

    formatINR(value) {
        if (!value || value === 0 || isNaN(value) || !isFinite(value)) return '₹0';
        const crore = value / 10000000;
        if (crore >= 1) return `₹${crore.toFixed(2)} Cr`;
        const lakh = value / 100000;
        if (lakh >= 1) return `₹${lakh.toFixed(2)} L`;
        return `₹${value.toLocaleString('en-IN')}`;
    }

    formatPercent(val) {
        if (val === null || val === undefined) return 'N/A';
        return (typeof val === 'number' ? val.toFixed(2) : val) + '%';
    }

    createCellBorders() {
        return {
            top: this.tableBorder,
            bottom: this.tableBorder,
            left: this.tableBorder,
            right: this.tableBorder
        };
    }

    createHeaderCell(text, width = 2000) {
        return new TableCell({
            borders: this.createCellBorders(),
            width: { size: width, type: WidthType.DXA },
            shading: { fill: this.COLOR_HEADER_BG, type: ShadingType.CLEAR },
            children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 60, after: 60 },
                children: [new TextRun({ text: this.sanitizeText(text), bold: true, size: 20, font: 'Arial' })]
            })]
        });
    }

    createDataCell(text, width = 2000, align = AlignmentType.LEFT, bold = false, color = '000000') {
        return new TableCell({
            borders: this.createCellBorders(),
            width: { size: width, type: WidthType.DXA },
            children: [new Paragraph({
                alignment: align,
                spacing: { before: 40, after: 40 },
                children: [new TextRun({ text: this.sanitizeText(text), bold, size: 18, font: 'Arial', color })]
            })]
        });
    }

    createStatusCell(status, width = 1500) {
        const isPass = status?.toLowerCase() === 'pass';
        return new TableCell({
            borders: this.createCellBorders(),
            width: { size: width, type: WidthType.DXA },
            shading: { fill: isPass ? 'dcfce7' : 'fee2e2', type: ShadingType.CLEAR },
            children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 40, after: 40 },
                children: [new TextRun({ 
                    text: isPass ? '✓ Pass' : '✗ Fail', 
                    bold: true, 
                    size: 18, 
                    font: 'Arial',
                    color: isPass ? this.COLOR_SUCCESS : this.COLOR_DANGER
                })]
            })]
        });
    }

    /**
     * Generate a standalone CAM document in AFL's exact format (Part A / Part B
     * / Annexure II only). Use this when AFL wants their format specifically,
     * vs generateReport() which produces the full analytical assessment.
     */
    async generateAflCamReport(assessment) {
        const children = this.generateAflCamSection(assessment);

        children.push(new Paragraph({
            spacing: { before: 300 }, alignment: AlignmentType.CENTER,
            children: [new TextRun({
                text: `Generated on ${new Date().toLocaleString('en-IN')} | Axis Finance Limited`,
                size: 16, color: '666666', font: 'Arial'
            })]
        }));

        const doc = new Document({
            styles: { default: { document: { run: { font: 'Arial', size: 18 } } } },
            sections: [{
                properties: {
                    page: {
                        // A4 dimensions from sample (DXA: 1440 per inch)
                        size: { width: 11906, height: 16838 },
                        margin: {
                            top:    914,
                            bottom: 914,
                            left:   914,
                            right:  1080,
                        }
                    }
                },
                children
            }]
        });
        return await Packer.toBuffer(doc);
    }

    async generateReport(assessment) {
        const cs = assessment.credit_score || assessment.calculations?.credit_score;
        const calc = assessment.calculations;
        const ed = assessment.extracted_data || {};
        const limits = assessment.recommended_limits;
        const pc = assessment.policy_compliance || [];
        
        const decision = assessment.status === 'Approved' ? 'APPROVED' : 
                        assessment.status === 'Rejected' ? 'REJECTED' : 'PARTIAL APPROVAL';
        const grade = cs?.grade || assessment.grade || 'N/A';
        const score = cs?.total || assessment.score || 0;
        const maxScore = cs?.max || 100;

        const children = [];

        // ========== SECTION 1: COVER/SUMMARY ==========
        children.push(
            new Paragraph({ 
                alignment: AlignmentType.CENTER,
                spacing: { after: 100 },
                children: [new TextRun({ text: 'CREDIT ASSESSMENT REPORT', size: 36, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })]
            }),
            new Paragraph({ 
                alignment: AlignmentType.CENTER,
                spacing: { after: 200 },
                children: [new TextRun({ text: assessment.company_name || 'Company Name', size: 28, bold: true, font: 'Arial' })]
            })
        );

        // Decision Summary Table (compact)
        children.push(new Table({
            columnWidths: [3500, 5860],
            rows: [
                new TableRow({ children: [
                    this.createHeaderCell('Credit Decision', 3500),
                    new TableCell({
                        borders: this.createCellBorders(),
                        width: { size: 5860, type: WidthType.DXA },
                        shading: { fill: decision.includes('APPROVED') ? 'dcfce7' : decision.includes('REJECTED') ? 'fee2e2' : 'fef3c7', type: ShadingType.CLEAR },
                        children: [new Paragraph({
                            alignment: AlignmentType.CENTER,
                            spacing: { before: 60, after: 60 },
                            children: [new TextRun({ text: decision, bold: true, size: 24, 
                                color: decision.includes('APPROVED') ? this.COLOR_SUCCESS : decision.includes('REJECTED') ? this.COLOR_DANGER : this.COLOR_WARNING })]
                        })]
                    })
                ]}),
                new TableRow({ children: [this.createHeaderCell('Credit Score', 3500), this.createDataCell(`${score} / ${maxScore} (Grade: ${grade})`, 5860, AlignmentType.CENTER, true)] }),
                new TableRow({ children: [this.createHeaderCell('Assessment ID', 3500), this.createDataCell(assessment.assessment_id || 'N/A', 5860, AlignmentType.CENTER)] }),
                new TableRow({ children: [this.createHeaderCell('Loan Amount', 3500), this.createDataCell(this.formatINR((assessment.loan_amount_lakhs || 0) * 100000), 5860, AlignmentType.CENTER, true)] }),
                new TableRow({ children: [this.createHeaderCell('Date', 3500), this.createDataCell(new Date(assessment.created_at || Date.now()).toLocaleDateString('en-IN'), 5860, AlignmentType.CENTER)] })
            ]
        }));

        // ========== SECTION 2: CREDIT SCORE BREAKDOWN ==========
        if (cs?.components && Object.keys(cs.components).length > 0) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '1. Credit Score Breakdown', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] })
            );

            const scoreRows = [
                new TableRow({ children: [
                    this.createHeaderCell('Component', 3500),
                    this.createHeaderCell('Score', 2000),
                    this.createHeaderCell('Max', 1500),
                    this.createHeaderCell('Achievement', 2360)
                ]})
            ];

            Object.entries(cs.components).forEach(([key, comp]) => {
                if (comp && comp.score !== undefined) {
                    scoreRows.push(new TableRow({ children: [
                        this.createDataCell(comp.name || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()), 3500),
                        this.createDataCell(String(comp.score), 2000, AlignmentType.CENTER, true),
                        this.createDataCell(String(comp.max || 20), 1500, AlignmentType.CENTER),
                        this.createDataCell(`${Math.round((comp.score/(comp.max||20))*100)}%`, 2360, AlignmentType.CENTER)
                    ]}));
                }
            });

            children.push(new Table({ columnWidths: [3500, 2000, 1500, 2360], rows: scoreRows }));
        }

        // ========== SECTION 3: RECOMMENDED LIMITS ==========
        if (limits && (limits.working_capital || limits.term_loan || limits.overdraft)) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '2. Recommended Limits', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] })
            );

            const limitRows = [
                new TableRow({ children: [
                    this.createHeaderCell('Facility', 2500),
                    this.createHeaderCell('Amount', 2200),
                    this.createHeaderCell('Method', 4660)
                ]})
            ];

            if (limits.working_capital?.amount) {
                limitRows.push(new TableRow({ children: [
                    this.createDataCell('Working Capital', 2500, AlignmentType.LEFT, true),
                    this.createDataCell(limits.working_capital.formatted || this.formatINR(limits.working_capital.amount), 2200, AlignmentType.RIGHT, true, this.COLOR_PRIMARY),
                    this.createDataCell(limits.working_capital.method || 'Drawing Power', 4660)
                ]}));
            }
            if (limits.term_loan?.amount) {
                limitRows.push(new TableRow({ children: [
                    this.createDataCell('Term Loan', 2500, AlignmentType.LEFT, true),
                    this.createDataCell(limits.term_loan.formatted || this.formatINR(limits.term_loan.amount), 2200, AlignmentType.RIGHT, true, this.COLOR_SUCCESS),
                    this.createDataCell(limits.term_loan.method || 'DSCR Based', 4660)
                ]}));
            }
            if (limits.overdraft?.amount) {
                limitRows.push(new TableRow({ children: [
                    this.createDataCell('Overdraft', 2500, AlignmentType.LEFT, true),
                    this.createDataCell(limits.overdraft.formatted || this.formatINR(limits.overdraft.amount), 2200, AlignmentType.RIGHT, true, '7c3aed'),
                    this.createDataCell(limits.overdraft.method || 'Turnover Based', 4660)
                ]}));
            }
            if (limits.total?.amount) {
                limitRows.push(new TableRow({ children: [
                    this.createDataCell('TOTAL', 2500, AlignmentType.LEFT, true),
                    this.createDataCell(limits.total.formatted || this.formatINR(limits.total.amount), 2200, AlignmentType.RIGHT, true, this.COLOR_PRIMARY),
                    this.createDataCell('', 4660)
                ]}));
            }

            children.push(new Table({ columnWidths: [2500, 2200, 4660], rows: limitRows }));
        }

        // ========== SECTION 4: SECURITY & COVERAGE ==========
        const securityContent = this.generateSecuritySection(ed, limits);
        if (securityContent.length > 0) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '3. Security & Coverage', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] }),
                ...securityContent
            );
        }

        // ========== SECTION 4.5: AI RECOMMENDATIONS ==========
        const recsContent = this.generateRecommendationsSection(ed, limits, calc, assessment);
        if (recsContent.length > 0) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '💡 Recommendations', size: 24, bold: true, font: 'Arial', color: this.COLOR_WARNING })] }),
                ...recsContent
            );
        }

        // ========== SECTION 5: FINANCIAL PERFORMANCE ==========
        const financialContent = this.generateFinancialSection(ed);
        if (financialContent.length > 0) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '4. Financial Performance', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] }),
                ...financialContent
            );
        }

        // ========== SECTION 6: KEY RATIOS ==========
        const ratiosContent = this.generateRatiosSection(calc);
        if (ratiosContent.length > 0) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '5. Key Ratios Analysis', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] }),
                ...ratiosContent
            );
        }

        // ========== SECTION 7: POLICY COMPLIANCE ==========
        if (pc && pc.length > 0) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '6. Policy Compliance', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] })
            );

            const policyRows = [
                new TableRow({ children: [
                    this.createHeaderCell('Parameter', 3000),
                    this.createHeaderCell('Actual', 1500),
                    this.createHeaderCell('Policy Norm', 1800),
                    this.createHeaderCell('Status', 1500)
                ]})
            ];

            pc.forEach(p => {
                policyRows.push(new TableRow({ children: [
                    this.createDataCell(p.param || p.name, 3000),
                    this.createDataCell(p.actual || '-', 1500, AlignmentType.RIGHT, true),
                    this.createDataCell(p.norm || '-', 1800, AlignmentType.CENTER),
                    this.createStatusCell(p.status, 1500)
                ]}));
            });

            children.push(new Table({ columnWidths: [3000, 1500, 1800, 1500], rows: policyRows }));
        }

        // ========== SECTION 7: LEGAL/COLLATERAL ASSESSMENT ==========
        const legalAssessment = ed?.legal_risk_assessment;
        if (legalAssessment && legalAssessment.properties && legalAssessment.properties.length > 0) {
            children.push(
                new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '7. Legal/Collateral Assessment', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] })
            );

            // Summary
            const summary = legalAssessment.summary || {};
            children.push(new Table({
                columnWidths: [3000, 2500, 2500, 1360],
                rows: [
                    new TableRow({ children: [
                        this.createHeaderCell('Properties', 3000),
                        this.createHeaderCell('Overall Risk', 2500),
                        this.createHeaderCell('Enforceability', 2500),
                        this.createHeaderCell('High Risk', 1360)
                    ]}),
                    new TableRow({ children: [
                        this.createDataCell(String(summary.total_properties || legalAssessment.properties.length), 3000, AlignmentType.CENTER, true),
                        this.createDataCell(summary.overall_risk_rating || 'N/A', 2500, AlignmentType.CENTER, true, 
                            summary.overall_risk_rating === 'High' ? this.COLOR_DANGER : 
                            summary.overall_risk_rating === 'Medium' ? this.COLOR_WARNING : this.COLOR_SUCCESS),
                        this.createDataCell(summary.overall_enforceability || 'N/A', 2500, AlignmentType.CENTER, true),
                        this.createDataCell(String(summary.high_risk_count || 0), 1360, AlignmentType.CENTER, true, 
                            (summary.high_risk_count || 0) > 0 ? this.COLOR_DANGER : this.COLOR_SUCCESS)
                    ]})
                ]
            }));

            // Property details
            legalAssessment.properties.forEach((prop, idx) => {
                children.push(
                    new Paragraph({ spacing: { before: 200, after: 80 }, children: [
                        new TextRun({ text: `Property ${idx + 1}: `, size: 20, bold: true, font: 'Arial', color: this.COLOR_PRIMARY }),
                        new TextRun({ text: this.sanitizeText(prop.property_address || 'Address not provided'), size: 20, font: 'Arial' })
                    ]})
                );

                const propRows = [
                    new TableRow({ children: [
                        this.createHeaderCell('Parameter', 4000),
                        this.createHeaderCell('Status/Value', 5360)
                    ]})
                ];

                // Add property details
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Property Type', 4000),
                    this.createDataCell(prop.property_type || 'N/A', 5360)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('State', 4000),
                    this.createDataCell(prop.state || 'N/A', 5360)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Title Chain Status', 4000),
                    this.createDataCell(prop.ownership_analysis?.title_chain_status || 'N/A', 5360, AlignmentType.LEFT, true,
                        prop.ownership_analysis?.title_chain_status === 'Clean' ? this.COLOR_SUCCESS : this.COLOR_DANGER)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Encumbrance Status', 4000),
                    this.createDataCell(prop.encumbrance_analysis?.has_adverse_entries ? 'Adverse Entries Found' : 'Clear', 5360, AlignmentType.LEFT, true,
                        prop.encumbrance_analysis?.has_adverse_entries ? this.COLOR_DANGER : this.COLOR_SUCCESS)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Litigation/Lis Pendens', 4000),
                    this.createDataCell(prop.litigation_analysis?.has_litigation ? 'Yes' : 'No', 5360, AlignmentType.LEFT, true,
                        prop.litigation_analysis?.has_litigation ? this.COLOR_DANGER : this.COLOR_SUCCESS)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Mutation Status', 4000),
                    this.createDataCell(prop.revenue_municipal_analysis?.mutation_status || 'N/A', 5360)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Property Tax Dues', 4000),
                    this.createDataCell(prop.revenue_municipal_analysis?.dues_amount ? `₹${prop.revenue_municipal_analysis.dues_amount.toLocaleString('en-IN')}` : 'Nil', 5360)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Risk Rating', 4000),
                    this.createDataCell(prop.risk_rating || 'N/A', 5360, AlignmentType.LEFT, true,
                        prop.risk_rating === 'High' ? this.COLOR_DANGER : prop.risk_rating === 'Medium' ? this.COLOR_WARNING : this.COLOR_SUCCESS)
                ]}));
                propRows.push(new TableRow({ children: [
                    this.createDataCell('Enforceability Decision', 4000),
                    this.createDataCell(prop.enforceability_decision || 'N/A', 5360, AlignmentType.LEFT, true)
                ]}));

                children.push(new Table({ columnWidths: [4000, 5360], rows: propRows }));

                // Blocking issues if any
                if (prop.blocking_issues && prop.blocking_issues.length > 0) {
                    children.push(
                        new Paragraph({ spacing: { before: 80, after: 40 }, children: [
                            new TextRun({ text: 'Blocking Issues:', size: 18, bold: true, font: 'Arial', color: this.COLOR_DANGER })
                        ]})
                    );
                    prop.blocking_issues.forEach(issue => {
                        children.push(new Paragraph({ spacing: { after: 20 }, children: [
                            new TextRun({ text: `• ${this.sanitizeText(issue)}`, size: 18, font: 'Arial', color: this.COLOR_DANGER })
                        ]}));
                    });
                }

                // Recommended actions if any
                if (prop.recommended_actions && prop.recommended_actions.length > 0) {
                    children.push(
                        new Paragraph({ spacing: { before: 80, after: 40 }, children: [
                            new TextRun({ text: 'Recommended Actions:', size: 18, bold: true, font: 'Arial', color: this.COLOR_WARNING })
                        ]})
                    );
                    prop.recommended_actions.slice(0, 5).forEach(action => {
                        children.push(new Paragraph({ spacing: { after: 20 }, children: [
                            new TextRun({ text: `• ${this.sanitizeText(action)}`, size: 18, font: 'Arial' })
                        ]}));
                    });
                }
            });

            // Key Findings
            if (summary.key_findings && summary.key_findings.length > 0) {
                children.push(
                    new Paragraph({ spacing: { before: 150, after: 60 }, children: [
                        new TextRun({ text: 'Key Findings:', size: 20, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })
                    ]})
                );
                summary.key_findings.slice(0, 10).forEach(finding => {
                    children.push(new Paragraph({ spacing: { after: 20 }, children: [
                        new TextRun({ text: `• ${this.sanitizeText(finding)}`, size: 18, font: 'Arial' })
                    ]}));
                });
            }
        }

        // ========== SECTION 8: TERMS & CONDITIONS ==========
        children.push(
            new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '8. Terms & Conditions', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] }),
            new Paragraph({ spacing: { before: 60, after: 40 }, children: [new TextRun({ text: 'Standard Conditions:', size: 20, bold: true, font: 'Arial' })] }),
            new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: '• Personal Guarantee of all Directors', size: 18, font: 'Arial' })] }),
            new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: '• Hypothecation of Stock & Book Debts', size: 18, font: 'Arial' })] }),
            new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: '• Monthly Stock/Debtor statements', size: 18, font: 'Arial' })] }),
            new Paragraph({ spacing: { before: 100, after: 40 }, children: [new TextRun({ text: 'Financial Covenants:', size: 20, bold: true, font: 'Arial' })] }),
            new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: '• Current Ratio > 1.25 | Debt/Equity < 2.0 | DSCR > 1.5x', size: 18, font: 'Arial' })] }),
            new Paragraph({ spacing: { after: 30 }, children: [new TextRun({ text: '• No dividend without bank NOC | Annual financials within 180 days', size: 18, font: 'Arial' })] })
        );

        // ========== CAM ELIGIBILITY ==========
        const camResult = assessment.cam_eligibility || assessment.calculations?.cam_eligibility || calc?.cam_eligibility;
        if (camResult && camResult.summary) {
            children.push(...this.generateCamSection(camResult));
        }

        // ========== FOOTER ==========
        children.push(
            new Paragraph({ 
                spacing: { before: 300 },
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: `Generated on ${new Date().toLocaleString('en-IN')} | © 2025 Applied Cloud Computing`, size: 16, color: '666666', font: 'Arial' })]
            })
        );

        const doc = new Document({
            styles: {
                default: { document: { run: { font: 'Arial', size: 20 } } }
            },
            sections: [{
                properties: {
                    page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } }
                },
                headers: {
                    default: new Header({
                        children: [new Paragraph({
                            alignment: AlignmentType.RIGHT,
                            children: [
                                new TextRun({ text: 'Credit Assessment | ', size: 16, font: 'Arial', color: '999999' }),
                                new TextRun({ text: assessment.company_name || '', size: 16, font: 'Arial', bold: true, color: '666666' })
                            ]
                        })]
                    })
                },
                footers: {
                    default: new Footer({
                        children: [new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [
                                new TextRun({ text: 'Page ', size: 16, font: 'Arial', color: '999999' }),
                                new TextRun({ children: [PageNumber.CURRENT], size: 16, font: 'Arial' }),
                                new TextRun({ text: ' of ', size: 16, font: 'Arial', color: '999999' }),
                                new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, font: 'Arial' })
                            ]
                        })]
                    })
                },
                children
            }]
        });

        return await Packer.toBuffer(doc);
    }

    generateSecuritySection(ed, limits) {
        const bs = ed?.balance_sheet?.fy25 || ed?.balance_sheet?.fy24 || ed?.balance_sheet?.fy23;
        if (!bs) return [];

        const stock = bs.inventory || bs.inventories || bs.stock || bs.closing_stock || bs.stock_in_trade || 0;
        const debtors = bs.trade_receivables || bs.sundry_debtors || bs.debtors || bs.receivables || 0;
        
        if (stock === 0 && debtors === 0) return [];

        const stockMargin = 0.25;
        const debtorMargin = 0.40;
        const stockEligible = stock * (1 - stockMargin);
        const debtorEligible = debtors * (1 - debtorMargin);
        const primaryTotal = stockEligible + debtorEligible;
        const totalExposure = limits?.total?.amount || (limits?.working_capital?.amount||0)+(limits?.term_loan?.amount||0)+(limits?.overdraft?.amount||0);
        const coverage = totalExposure > 0 ? Math.round((primaryTotal / totalExposure) * 100) : 0;

        return [
            new Paragraph({ 
                spacing: { after: 100 },
                children: [
                    new TextRun({ text: 'Collateral Coverage: ', size: 20, font: 'Arial' }),
                    new TextRun({ text: `${coverage}%`, size: 24, bold: true, font: 'Arial', color: coverage >= 100 ? this.COLOR_SUCCESS : this.COLOR_DANGER })
                ]
            }),
            new Table({
                columnWidths: [5500, 3860],
                rows: [
                    new TableRow({ children: [this.createHeaderCell('Primary Security', 5500), this.createHeaderCell('Amount', 3860)] }),
                    new TableRow({ children: [this.createDataCell('Stock Hypothecation', 5500), this.createDataCell(this.formatINR(stock), 3860, AlignmentType.RIGHT)] }),
                    new TableRow({ children: [this.createDataCell('Less: Margin (25%)', 5500), this.createDataCell(`-${this.formatINR(stock * stockMargin)}`, 3860, AlignmentType.RIGHT, false, this.COLOR_DANGER)] }),
                    new TableRow({ children: [this.createDataCell('Debtor Hypothecation', 5500), this.createDataCell(this.formatINR(debtors), 3860, AlignmentType.RIGHT)] }),
                    new TableRow({ children: [this.createDataCell('Less: Margin (40%)', 5500), this.createDataCell(`-${this.formatINR(debtors * debtorMargin)}`, 3860, AlignmentType.RIGHT, false, this.COLOR_DANGER)] }),
                    new TableRow({ children: [this.createDataCell('Eligible Primary Security', 5500, AlignmentType.LEFT, true), this.createDataCell(this.formatINR(primaryTotal), 3860, AlignmentType.RIGHT, true, this.COLOR_SUCCESS)] }),
                    new TableRow({ children: [this.createDataCell('Total Exposure', 5500), this.createDataCell(this.formatINR(totalExposure), 3860, AlignmentType.RIGHT)] }),
                    new TableRow({ children: [this.createDataCell('Coverage Ratio', 5500, AlignmentType.LEFT, true), this.createDataCell(`${coverage}%`, 3860, AlignmentType.RIGHT, true, coverage >= 100 ? this.COLOR_SUCCESS : this.COLOR_DANGER)] })
                ]
            })
        ];
    }

    generateRecommendationsSection(ed, limits, calc, assessment) {
        const result = [];
        const bs = ed?.balance_sheet?.fy25 || ed?.balance_sheet?.fy24 || {};
        const pnl = ed?.profit_and_loss?.fy25 || ed?.profit_and_loss?.fy24 || {};
        
        // Calculate security values
        const stock = bs.inventory || bs.inventories || 0;
        const debtors = bs.trade_receivables || bs.sundry_debtors || 0;
        const stockEligible = stock * 0.75;
        const debtorEligible = debtors * 0.60;
        const primarySecurity = stockEligible + debtorEligible;
        
        // Get financial metrics
        const pat = pnl.profit_after_tax || pnl.net_profit || 0;
        const revenue = pnl.revenue || pnl.total_revenue || 0;
        const netWorth = bs.net_worth || bs.shareholders_funds || bs.total_equity || 0;
        const currentRatio = calc?.liquidity?.current_ratio?.value || 0;
        const dscr = calc?.leverage?.dscr?.value || 0;
        const debtEquity = calc?.leverage?.debt_equity?.value || 0;
        
        // Total exposure
        const totalExposure = limits?.total?.amount || (assessment.loan_amount_lakhs || 0) * 100000 || 0;
        const coverage = totalExposure > 0 ? (primarySecurity / totalExposure * 100) : 0;
        const securityGap = Math.max(0, totalExposure - primarySecurity);
        
        // Only show if there's a coverage gap
        if (coverage >= 100 || totalExposure === 0) {
            return [];
        }
        
        // Build summary
        const strengths = [];
        if (pat > 0) strengths.push(`PAT ${this.formatINR(pat)}`);
        if (currentRatio >= 1.25) strengths.push(`Current Ratio ${currentRatio.toFixed(2)}`);
        if (debtEquity < 1) strengths.push('low debt');
        
        const summaryText = strengths.length > 0 
            ? `Despite strong financials (${strengths.join(', ')}), the primary security coverage is only ${Math.round(coverage)}% for a ${this.formatINR(totalExposure)} loan.`
            : `Primary security coverage is only ${Math.round(coverage)}% for a ${this.formatINR(totalExposure)} exposure.`;
        
        result.push(new Paragraph({
            spacing: { after: 150 },
            children: [new TextRun({ text: summaryText, size: 20, font: 'Arial', italics: true })]
        }));
        
        result.push(new Paragraph({
            spacing: { before: 100, after: 100 },
            children: [new TextRun({ text: 'Options to improve coverage:', size: 20, bold: true, font: 'Arial' })]
        }));
        
        // Option 1: Reduce loan amount
        if (primarySecurity > 0) {
            result.push(new Paragraph({
                spacing: { after: 60 },
                children: [new TextRun({ text: `1. Reduce loan amount to ${this.formatINR(primarySecurity)} (100% covered)`, size: 18, font: 'Arial' })]
            }));
        }
        
        // Option 2: Add collateral
        if (securityGap > 0) {
            result.push(new Paragraph({
                spacing: { after: 60 },
                children: [new TextRun({ text: `2. Add collateral - Property/Fixed Assets worth ${this.formatINR(securityGap)}`, size: 18, font: 'Arial' })]
            }));
        }
        
        // Option 3: Personal guarantee
        result.push(new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: '3. Personal Guarantee of directors + property mortgage', size: 18, font: 'Arial' })]
        }));
        
        // Option 4: CGTMSE
        if (totalExposure <= 50000000) {
            result.push(new Paragraph({
                spacing: { after: 60 },
                children: [new TextRun({ text: '4. CGTMSE coverage for eligible portion', size: 18, font: 'Arial' })]
            }));
        }
        
        return result;
    }

    generateFinancialSection(ed) {
        const pnl = ed?.profit_and_loss;
        const bsData = ed?.balance_sheet;
        
        if (!pnl && !bsData) return [];

        const years = [];
        if (pnl?.fy23 || bsData?.fy23) years.push('fy23');
        if (pnl?.fy24 || bsData?.fy24) years.push('fy24');
        if (pnl?.fy25 || bsData?.fy25) years.push('fy25');

        if (years.length === 0) return [];

        const colWidth = Math.floor(6360 / years.length);
        const rows = [
            new TableRow({ children: [
                this.createHeaderCell('Particulars', 3000),
                ...years.map(yr => this.createHeaderCell(yr.toUpperCase().replace('FY', 'FY '), colWidth))
            ]})
        ];

        // Only add rows with actual data
        const revenues = years.map(yr => pnl?.[yr]?.revenue || pnl?.[yr]?.total_revenue || 0);
        if (revenues.some(v => v > 0)) {
            rows.push(new TableRow({ children: [
                this.createDataCell('Revenue', 3000, AlignmentType.LEFT, true),
                ...revenues.map(rev => this.createDataCell(this.formatINR(rev), colWidth, AlignmentType.RIGHT))
            ]}));
        }

        const pats = years.map(yr => pnl?.[yr]?.profit_after_tax || pnl?.[yr]?.net_profit || 0);
        if (pats.some(v => v !== 0)) {
            rows.push(new TableRow({ children: [
                this.createDataCell('Profit After Tax', 3000),
                ...pats.map(pat => this.createDataCell(this.formatINR(pat), colWidth, AlignmentType.RIGHT, false, pat < 0 ? this.COLOR_DANGER : '000000'))
            ]}));
        }

        const netWorths = years.map(yr => bsData?.[yr]?.net_worth || bsData?.[yr]?.shareholders_funds || 0);
        if (netWorths.some(v => v > 0)) {
            rows.push(new TableRow({ children: [
                this.createDataCell('Net Worth', 3000),
                ...netWorths.map(nw => this.createDataCell(this.formatINR(nw), colWidth, AlignmentType.RIGHT))
            ]}));
        }

        if (rows.length <= 1) return []; // Only header, no data

        return [new Table({ columnWidths: [3000, ...years.map(() => colWidth)], rows })];
    }

    generateRatiosSection(calc) {
        if (!calc) return [];

        const allRatios = [];
        if (calc.liquidity?.current_ratio?.result !== undefined) allRatios.push(calc.liquidity.current_ratio);
        if (calc.liquidity?.quick_ratio?.result !== undefined) allRatios.push(calc.liquidity.quick_ratio);
        if (calc.leverage?.debt_equity?.result !== undefined) allRatios.push(calc.leverage.debt_equity);
        if (calc.leverage?.dscr?.result !== undefined) allRatios.push(calc.leverage.dscr);
        if (calc.leverage?.interest_coverage?.result !== undefined) allRatios.push(calc.leverage.interest_coverage);
        if (calc.profitability?.net_profit_margin?.result !== undefined) allRatios.push(calc.profitability.net_profit_margin);
        if (calc.profitability?.roe?.result !== undefined) allRatios.push(calc.profitability.roe);

        if (allRatios.length === 0) return [];

        const rows = [
            new TableRow({ children: [
                this.createHeaderCell('Ratio', 3500),
                this.createHeaderCell('Actual', 1800),
                this.createHeaderCell('Benchmark', 1800),
                this.createHeaderCell('Status', 1260)
            ]})
        ];

        allRatios.forEach(ratio => {
            rows.push(new TableRow({ children: [
                this.createDataCell(ratio.name, 3500),
                this.createDataCell(ratio.result_display || String(ratio.result || '-'), 1800, AlignmentType.RIGHT, true),
                this.createDataCell(ratio.policy_norm || '-', 1800, AlignmentType.CENTER),
                this.createStatusCell(ratio.status, 1260)
            ]}));
        });

        return [new Table({ columnWidths: [3500, 1800, 1800, 1260], rows })];
    }

    /**
     * Build the CAM (Credit Assessment Model) Eligibility section.
     * @param {Object} cam - normalised CAM result from cam-eligibility.js
     * @returns {Array} docx children
     */
    /**
     * AFL-standard CAM format — Part A (Client Details), Part B (Proposal
     * Details), Annexure II (Repayment Schedule). Matches the exact template
     * AFL provided (Sample_CAM-EM-Pennant).
     *
     * Field sources:
     *  - Pennant (pennant_data.customer / .loanDetail / .collateral)
     *  - Calculation engine (cam_eligibility / calculations) for eligibility,
     *    proposed loan, EMI, LTV
     *  - AFL user manual entry (fields Pennant/calculation don't provide are
     *    rendered as blank cells for the underwriter to complete)
     */
    generateAflCamSection(assessment) {
        // Exact match to Sample_CAM_Report_output__3__1.docx
        // Page: A4 portrait, margins ~720 DXA each side → usable width 9196 DXA
        // No coloured headers — black borders, bold labels, plain values
        const out = [];

        const pen  = assessment.pennant_data || {};
        const cust = pen.customer   || {};
        const loan = pen.loanDetail || {};
        const camResult = assessment.cam_eligibility || assessment.calculations?.cam_eligibility || {};
        const camSummary = camResult.summary || {};
        const camSteps   = camResult.steps   || [];
        const camChecks  = camResult.policy_checks || [];
        const camFlags   = camResult.flags   || [];

        // ── helpers ──────────────────────────────────────────────────────────
        const V = v => (v === null || v === undefined || v === '') ? '' : String(v);
        const fmtL = (v) => {  // format lakhs number nicely
            if (!v && v !== 0) return '';
            const n = parseFloat(v);
            if (isNaN(n)) return V(v);
            return '₹ ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L';
        };
        const fmtCr = (v) => {
            if (!v && v !== 0) return '';
            const n = parseFloat(v);
            if (isNaN(n)) return V(v);
            if (n >= 100) return '₹' + (n/100).toFixed(2) + ' Cr';
            return '₹' + n.toFixed(2) + ' L';
        };
        const pct = (v) => (v || v === 0) ? parseFloat(v).toFixed(2) + '%' : '';

        const borders = () => ({
            top:    { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            left:   { style: BorderStyle.SINGLE, size: 4, color: '000000' },
            right:  { style: BorderStyle.SINGLE, size: 4, color: '000000' },
        });

        const cell = (text, width, bold = false, align = AlignmentType.LEFT, shade = null) => {
            const props = {
                borders: borders(),
                width: { size: width, type: WidthType.DXA },
                margins: { top: 30, bottom: 30, left: 80, right: 80 },
                children: [new Paragraph({
                    alignment: align,
                    children: [new TextRun({ text: V(text), bold, size: 18, font: 'Arial', color: '000000' })]
                })]
            };
            if (shade) props.shading = shade;
            return new TableCell(props);
        };

        // 2-col row: label (2200) | value (6996) = 9196
        const row2 = (label, value, labelBold = true) => new TableRow({ children: [
            cell(label, 2200, labelBold),
            cell(value, 6996, false),
        ]});

        // 4-col row for the detail grid: l1(1900) v1(2698) l2(2000) v2(2598) = 9196
        const row4 = (l1, v1, l2, v2) => new TableRow({ children: [
            cell(l1, 1900, true),
            cell(v1, 2698, false),
            cell(l2, 2000, true),
            cell(v2, 2598, false),
        ]});

        // Full-width span row (section divider within Part A tables)
        const rowSpan2 = (text, bold = false, shade = null) => new TableRow({ children: [
            new TableCell({
                borders: borders(),
                columnSpan: 2,
                width: { size: 9196, type: WidthType.DXA },
                margins: { top: 30, bottom: 30, left: 80, right: 80 },
                ...(shade ? { shading: shade } : {}),
                children: [new Paragraph({
                    children: [new TextRun({ text: V(text), bold, size: 18, font: 'Arial', color: '000000' })]
                })]
            })
        ]});

        // section paragraph (bold, 10pt = size 20 half-pts)
        const secPara = (text, bold = true, color = '000000') => new Paragraph({
            spacing: { before: 160, after: 60 },
            children: [new TextRun({ text, bold, size: 20, font: 'Arial', color })]
        });

        // ── Date ────────────────────────────────────────────────────────────
        const dateStr = new Date(assessment.created_at || Date.now())
            .toLocaleDateString('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric' });
        out.push(new Paragraph({
            spacing: { before: 0, after: 80 },
            children: [new TextRun({ text: `Date: ${dateStr}`, bold: true, size: 20, font: 'Arial' })]
        }));

        // ════════════════════════════════════════════════════════════════════
        // PART A — Client Details (tables T0–T10 of sample)
        // ════════════════════════════════════════════════════════════════════
        out.push(secPara("Part A\u2019 \u2013 Client Details"));

        // T0: Borrower Company — wider label col (2600 / 6596)
        out.push(new Table({ columnWidths: [2600, 6596], rows: [
            new TableRow({ children: [
                cell('Borrower Company', 2600, true),
                cell(cust.name || '', 6596),
            ]})
        ]}));

        // T1: Customer Details
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Customer Details', cust.customerCode || cust.custCif || '') ]}));
        // T2: UCIC
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Borrower UCIC No.', loan.ucic || '') ]}));
        // T3: Address
        out.push(new Table({ columnWidths: [2200, 6996], rows: [
            row2('Address', [cust.address, cust.city, cust.state].filter(Boolean).join(', '))
        ]}));

        // T4: 11-row, 4-col detail grid (1900/2698/2000/2598)
        out.push(new Table({ columnWidths: [1900, 2698, 2000, 2598], rows: [
            row4('Phone Number',      cust.phone || '________',   'Email',           cust.email || '________'),
            row4('LEI No.',           cust.lei   || '________',   'LEI Expiry Date', cust.leiExpiry || '________'),
            row4('CIN',               cust.cin   || '________',   'Incorporation',   cust.incorporationDate || '________'),
            row4('Listed / Unlisted', cust.listedStatus || '________', 'Account Status', cust.dealingsSince || '________'),
            row4('Group',             cust.group || '________',   'Rating',          `Internal: ${cust.internalRating || '________'}  External: ${cust.externalRating || '________'}`),
            row4('Type of facility',  loan.loanType || '________', 'KYC Category',   cust.customerCategory || '________'),
            row4('Sourcing Officer',  cust.sourcingOfficer || '________', 'CKYC',    cust.ckycNo || '________'),
            row4('Secured / Unsecured', cust.securedUnsecured || '________', 'Category', cust.category || '________'),
            row4('RBI Industry Code', cust.industry || '________', 'Banking Arrangement', cust.bankingArrangement || '________'),
            // MSME spans full width (like sample R9)
            new TableRow({ children: [
                cell('MSME Tagging', 1900, true),
                new TableCell({
                    borders: borders(),
                    columnSpan: 3,
                    width: { size: 7296, type: WidthType.DXA },
                    margins: { top: 30, bottom: 30, left: 80, right: 80 },
                    children: [new Paragraph({ children: [new TextRun({ text: V(cust.msmeFlag) || 'YES', size: 18, font: 'Arial' })] })]
                })
            ]}),
            row4('Sector', cust.sectorDesc || '________', 'Sub Sector', cust.subSector || '________'),
        ]}));

        // T5–T10: single-row 2-col tables
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Shareholder Details', cust.shareholderDetails || '') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Relationship with Axis Bank Details', 'To be fetched from Other Details tab under Loan Queue') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Existing Loan Exposure with AFL', 'To be fetched from Banking Details tab under Customers') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('External Liabilities', 'To be fetched from Banking Details tab under Customers') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Single Borrower & Group Exposure', 'To be fetched from Other Details tab under Loan Queue') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('CRILC', cust.crilc || '') ]}));

        // ════════════════════════════════════════════════════════════════════
        // PART B — Proposal Details (T11–T19)
        // ════════════════════════════════════════════════════════════════════
        out.push(secPara("Part B\u2019 \u2013 Proposal Details"));

        out.push(new Table({ columnWidths: [2200, 6996], rows: [
            row2('Basic Loan Details', [loan.product, loan.loanType].filter(Boolean).join(' — '))
        ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Moratorium Period', '') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Payment Details', '') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Co-Applicant Details', 'To be fetched from Coapplicants and Guarantors tab under Loan Queue') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Guarantor Details', 'To be fetched from Coapplicants and Guarantors tab under Loan Queue') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Custom Deviations Details', 'To be fetched from Custom Deviations tab under Loan Queue.') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Security Details', 'To be fetched from Collateral Details under Loan Queue.') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('Put/Call', 'Details if applicable') ]}));
        out.push(new Table({ columnWidths: [2200, 6996], rows: [ row2('DCCO', 'To be fetched from DCCO Details under Loan Queue.') ]}));

        // ════════════════════════════════════════════════════════════════════
        // PART C — Financial Assessment & Eligibility (T20–T25)
        // ════════════════════════════════════════════════════════════════════
        out.push(secPara("Part C\u2019 \u2013 Financial Assessment & Eligibility"));

        const program = camResult.program_label || camResult.program || 'Cash Profit';
        out.push(new Paragraph({
            spacing: { before: 40, after: 80 },
            children: [new TextRun({
                text: `Assessed under the ${program} Eligibility Program. Figures generated by the CAM eligibility engine; amounts in \u20B9 Lakhs.`,
                size: 18, font: 'Arial'
            })]
        }));

        // ── Eligibility Calculation Working (T20) — 3-col: Particulars/Basis/Value ──
        out.push(secPara("Eligibility Calculation Working"));

        const hdrCell3 = (text, width) => new TableCell({
            borders: borders(),
            width: { size: width, type: WidthType.DXA },
            margins: { top: 30, bottom: 30, left: 80, right: 80 },
            children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 18, font: 'Arial' })] })]
        });
        const dataCell3 = (text, width, align = AlignmentType.LEFT) => new TableCell({
            borders: borders(),
            width: { size: width, type: WidthType.DXA },
            margins: { top: 30, bottom: 30, left: 80, right: 80 },
            children: [new Paragraph({ alignment: align, children: [new TextRun({ text: V(text), size: 18, font: 'Arial' })] })]
        });

        // Build calculation rows from camSteps or camSummary
        const S = camSummary;
        const calcRows = [
            new TableRow({ children: [ hdrCell3('Particulars', 3400), hdrCell3('Basis / Formula', 2900), hdrCell3('Value', 2896) ]}),
        ];

        // Attempt to render each step from the calculation engine output
        if (camSteps && camSteps.length > 0) {
            camSteps.forEach(step => {
                calcRows.push(new TableRow({ children: [
                    dataCell3(step.label || step.name || '', 3400),
                    dataCell3(step.formula || step.basis || '', 2900),
                    dataCell3(step.value_display || (step.value !== undefined ? V(step.value) : ''), 2896, AlignmentType.RIGHT),
                ]}));
            });
        } else {
            // Fallback: render from camSummary fields matching sample structure
            const rows = [
                ['Turnover / Receipts',             '',                                    fmtCr(S.turnover_cr)],
                ['PAT',                             '',                                    fmtCr(S.pat_cr)],
                ['Less: Non-operating Income',      '',                                    fmtCr(S.non_op_income_cr)],
                ['Add: Depreciation',               '',                                    fmtCr(S.depreciation_cr)],
                ['Add: Interest to Bank/FI',        '',                                    fmtCr(S.interest_cr)],
                ['EBIDTA (Net of Tax)',              'PAT - NonOp + Dep + Interest',        fmtCr(S.ebidta_cr || S.ebidta_lakhs ? S.ebidta_lakhs/100 : null)],
                ['Add: Related Party Payment',      '',                                    fmtCr(S.related_party_cr)],
                ['Add: Other Income',               '',                                    fmtCr(S.other_income_cr)],
                ['Total Annual Income (Cash Profit)','EBIDTA + Related Party + Other',     fmtCr(S.total_annual_income_cr)],
                ['Existing Obligation (Annual)',    '',                                    fmtCr(S.existing_obligation_cr)],
                ['Target DSCR',                     '',                                    S.target_dscr ? S.target_dscr + 'x' : ''],
                ['Max Annual Debt Service',         'Total Income / Target DSCR',          fmtCr(S.max_annual_ds_cr)],
                ['Max EMI Allowed (Monthly)',       '(Max DS - Existing) / 12',            S.max_emi_lakhs ? fmtL(S.max_emi_lakhs) : (S.max_emi_allowed_lakhs ? fmtL(S.max_emi_allowed_lakhs) : '')],
                ['Tenure (months)',                 '',                                    S.tenure_months ? S.tenure_months + ' months' : V(loan.tenureMonths ? loan.tenureMonths + ' months' : '')],
                ['Rate',                            '',                                    S.rate ? pct(S.rate * 100) : V(loan.interestRate ? pct(loan.interestRate) : '')],
                ['EMI Factor',                      'PMT(rate/12, n, -1)',                 S.emi_factor ? parseFloat(S.emi_factor).toFixed(4) : ''],
                ['Eligible Loan (basis Income)',    'Max EMI / EMI Factor',               S.eligible_loan_amount_lakhs ? fmtL(S.eligible_loan_amount_lakhs) : ''],
                ['Proposed Loan Amount',            '',                                    S.proposed_loan_lakhs ? fmtL(S.proposed_loan_lakhs) : fmtCr(loan.financeAmount/100)],
                ['Proposed Monthly EMI',            'PMT on proposed loan',               S.proposed_emi ? fmtL(S.proposed_emi) : ''],
                ['Total Obligation (Annual)',       'Existing + Proposed',                S.total_obligation_annual_cr ? fmtCr(S.total_obligation_annual_cr) : ''],
                ['Post-disbursement DSCR',         'Total Income / Total Obligation',     S.post_dscr ? S.post_dscr + 'x' : ''],
                ['Technical Valuation 1',          '',                                    S.tech_val_1_lakhs ? fmtL(S.tech_val_1_lakhs) : ''],
                ['Technical Valuation 2',          '',                                    S.tech_val_2_lakhs ? fmtL(S.tech_val_2_lakhs) : ''],
                ['Valuation Considered',           'Lower of valuations',                S.valuation_considered_lakhs ? fmtL(S.valuation_considered_lakhs) : ''],
                ['Eligible LTV %',                 'As per policy (less buffer)',         S.eligible_ltv_pct ? pct(S.eligible_ltv_pct) : ''],
                ['LTV % on Proposed Loan',         'Proposed Loan / Valuation',           S.ltv_on_proposed_pct ? pct(S.ltv_on_proposed_pct) : ''],
                ['LTV Deviation',                  'LTV on Proposed - Eligible LTV',      S.ltv_deviation_pct !== undefined ? pct(S.ltv_deviation_pct) : ''],
            ];
            rows.forEach(([particulars, basis, value]) => {
                calcRows.push(new TableRow({ children: [
                    dataCell3(particulars, 3400),
                    dataCell3(basis, 2900),
                    dataCell3(value, 2896, AlignmentType.RIGHT),
                ]}));
            });
        }
        out.push(new Table({ columnWidths: [3400, 2900, 2896], rows: calcRows }));

        // ── Eligibility Summary (T21) ────────────────────────────────────────
        out.push(secPara("Eligibility Summary"));
        out.push(new Table({ columnWidths: [2600, 6596], rows: [
            row2('EBIDTA (Net of Tax)',             S.ebidta_cr ? fmtCr(S.ebidta_cr) : (S.ebidta_lakhs ? fmtL(S.ebidta_lakhs) : '')),
            row2('Total Annual Income (Cash Profit)', S.total_annual_income_cr ? fmtCr(S.total_annual_income_cr) : (S.total_annual_income_lakhs ? fmtL(S.total_annual_income_lakhs) : '')),
            row2('Target DSCR',                    S.target_dscr ? S.target_dscr + 'x' : ''),
            row2('Max EMI Allowed (Monthly)',      S.max_emi_lakhs ? fmtL(S.max_emi_lakhs) : (S.max_emi_allowed_lakhs ? fmtL(S.max_emi_allowed_lakhs) : '')),
            row2('Eligible Loan Amount',           S.eligible_loan_amount_lakhs ? fmtL(S.eligible_loan_amount_lakhs) : ''),
            row2('Proposed Loan Amount',           S.proposed_loan_lakhs ? fmtL(S.proposed_loan_lakhs) : ''),
            row2('Proposed Monthly EMI',           S.proposed_emi ? fmtL(S.proposed_emi) : ''),
            row2('DSCR on Proposed',               S.post_dscr ? S.post_dscr + 'x' : ''),
        ]}));

        // ── Collateral & LTV (T22) ───────────────────────────────────────────
        out.push(secPara("Collateral & LTV"));
        out.push(new Table({ columnWidths: [2600, 6596], rows: [
            row2('Valuation Considered',  S.valuation_considered_lakhs ? fmtL(S.valuation_considered_lakhs) : ''),
            row2('Eligible LTV %',        S.eligible_ltv_pct ? pct(S.eligible_ltv_pct) : ''),
            row2('Eligible Loan (LTV basis)', S.eligible_loan_ltv_lakhs ? fmtL(S.eligible_loan_ltv_lakhs) : ''),
            row2('LTV % on Proposed Loan', S.ltv_on_proposed_pct ? pct(S.ltv_on_proposed_pct) : ''),
            row2('LTV Deviation',          S.ltv_deviation_pct !== undefined ? pct(S.ltv_deviation_pct) : ''),
        ]}));

        // ── Final Eligible Loan Amount (T23) ─────────────────────────────────
        out.push(secPara("Final Eligible Loan Amount"));
        out.push(new Table({ columnWidths: [2600, 6596], rows: [
            row2('Eligible Loan (Income / DSCR basis)', S.eligible_loan_amount_lakhs ? fmtL(S.eligible_loan_amount_lakhs) : ''),
            row2('Eligible Loan (LTV basis)',            S.eligible_loan_ltv_lakhs    ? fmtL(S.eligible_loan_ltv_lakhs) : ''),
            row2('Final Eligible Loan (lower of the two)', S.final_eligible_loan_lakhs ? fmtL(S.final_eligible_loan_lakhs) : (S.eligible_loan_amount_lakhs ? fmtL(Math.min(S.eligible_loan_amount_lakhs || Infinity, S.eligible_loan_ltv_lakhs || Infinity)) : '')),
            row2('Proposed Loan Amount',                 S.proposed_loan_lakhs ? fmtL(S.proposed_loan_lakhs) : ''),
            row2('Recommended Loan Amount',              S.recommended_loan_lakhs ? fmtL(S.recommended_loan_lakhs) : (S.proposed_loan_lakhs ? fmtL(S.proposed_loan_lakhs) : '')),
        ]}));

        // ── Policy Compliance & Flags (T24) ──────────────────────────────────
        out.push(secPara("Policy Compliance & Flags"));

        const policyRows = [
            new TableRow({ children: [
                hdrCell3('Policy Condition', 5396),
                hdrCell3('Norm', 1900),
                hdrCell3('Status', 1900),
            ]})
        ];

        if (camChecks && camChecks.length > 0) {
            camChecks.forEach(chk => {
                const status = chk.complied ? 'Complied' : 'Not Complied';
                const statusColor = chk.complied ? '1B7F3B' : 'C00000';
                policyRows.push(new TableRow({ children: [
                    new TableCell({
                        borders: borders(), width: { size: 5396, type: WidthType.DXA },
                        margins: { top: 30, bottom: 30, left: 80, right: 80 },
                        children: [new Paragraph({ children: [new TextRun({ text: V(chk.label), size: 18, font: 'Arial' })] })]
                    }),
                    new TableCell({
                        borders: borders(), width: { size: 1900, type: WidthType.DXA },
                        margins: { top: 30, bottom: 30, left: 80, right: 80 },
                        children: [new Paragraph({ children: [new TextRun({ text: V(chk.norm || 'Required'), size: 18, font: 'Arial' })] })]
                    }),
                    new TableCell({
                        borders: borders(), width: { size: 1900, type: WidthType.DXA },
                        margins: { top: 30, bottom: 30, left: 80, right: 80 },
                        children: [new Paragraph({ children: [new TextRun({ text: status, bold: true, size: 18, font: 'Arial', color: statusColor })] })]
                    }),
                ]}));
            });
        }
        out.push(new Table({ columnWidths: [5396, 1900, 1900], rows: policyRows }));

        // Deviation flags
        const deviationText = (camFlags && camFlags.length > 0)
            ? 'Deviation Flags: ' + camFlags.join('; ')
            : 'Deviation Flags: None \u2013 proposal is within all policy norms.';
        const devColor = (camFlags && camFlags.length > 0) ? 'C00000' : '1B7F3B';
        out.push(new Paragraph({
            spacing: { before: 80, after: 80 },
            children: [new TextRun({ text: deviationText, bold: true, size: 18, font: 'Arial', color: devColor })]
        }));

        // ── Decision / Recommendation (T25) ─────────────────────────────────
        out.push(secPara("Decision / Recommendation"));

        const withinPolicy = !camFlags || camFlags.length === 0;
        const overallStatus = withinPolicy ? 'WITHIN POLICY NORMS' : 'DEVIATION FROM POLICY';
        const recommendation = withinPolicy
            ? `RECOMMENDED FOR SANCTION \u2014 within income (DSCR) and LTV eligibility with policy conditions complied.`
            : `REFER TO CREDIT COMMITTEE \u2014 deviations noted: ${camFlags.join('; ')}.`;

        out.push(new Table({ columnWidths: [2600, 6596], rows: [
            row2('Overall Status',       overallStatus),
            row2('Final Eligible Amount', S.final_eligible_loan_lakhs ? fmtL(S.final_eligible_loan_lakhs) : ''),
            row2('Recommended Amount',   S.recommended_loan_lakhs ? fmtL(S.recommended_loan_lakhs) : (S.proposed_loan_lakhs ? fmtL(S.proposed_loan_lakhs) : '')),
            row2('Recommendation',       recommendation),
        ]}));

        // Signatories
        out.push(new Paragraph({
            spacing: { before: 200, after: 40 },
            children: [new TextRun({
                text: 'Prepared By: __________     Reviewed By: __________     Sanctioning Authority: __________',
                size: 18, font: 'Arial'
            })]
        }));

        // ════════════════════════════════════════════════════════════════════
        // ANNEXURE II — Repayment Schedule (T26)
        // ════════════════════════════════════════════════════════════════════
        out.push(new Paragraph({ spacing: { before: 200, after: 0 }, children: [] }));
        out.push(secPara("Annexure \u2013 II"));
        out.push(secPara("Repayment Schedule"));

        const rps = assessment.repayment_schedule || camResult.repayment_schedule || [];
        const rpsRows = [
            new TableRow({ children: [
                hdrCell3('Instalment No', 1800),
                hdrCell3('Date', 1900),
                hdrCell3('Interest', 1832),
                hdrCell3('Principal', 1832),
                hdrCell3('Repayment Amount', 1832),
            ]})
        ];

        if (rps.length) {
            rps.forEach((r, i) => {
                rpsRows.push(new TableRow({ children: [
                    dataCell3(V(r.instalment_no || (i + 1)), 1800, AlignmentType.CENTER),
                    dataCell3(V(r.date), 1900, AlignmentType.CENTER),
                    dataCell3(V(r.interest), 1832, AlignmentType.RIGHT),
                    dataCell3(V(r.principal), 1832, AlignmentType.RIGHT),
                    dataCell3(V(r.repayment_amount), 1832, AlignmentType.RIGHT),
                ]}));
            });
        } else {
            out.push(new Paragraph({
                spacing: { before: 40, after: 40 },
                children: [new TextRun({ text: 'RPS to be fetched from Loan Queue', size: 18, font: 'Arial' })]
            }));
        }
        if (rps.length) {
            out.push(new Table({ columnWidths: [1800, 1900, 1832, 1832, 1832], rows: rpsRows }));
        }

        return out;
    }

    generateCamSection(cam) {
        const out = [];
        const summary = cam.summary || {};
        const overall = cam.overall || {};
        const breaching = !!overall.breaching;

        // Section heading
        out.push(new Paragraph({
            spacing: { before: 300, after: 100 },
            children: [new TextRun({ text: '8. CAM Eligibility Assessment', size: 24, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })]
        }));

        // Program + decision banner
        out.push(new Table({
            columnWidths: [3500, 5860],
            rows: [
                new TableRow({ children: [
                    this.createHeaderCell('Eligibility Program', 3500),
                    this.createDataCell(cam.program_label || cam.program || 'N/A', 5860, AlignmentType.LEFT, true)
                ]}),
                new TableRow({ children: [
                    this.createHeaderCell('Policy Status', 3500),
                    new TableCell({
                        borders: this.createCellBorders(),
                        width: { size: 5860, type: WidthType.DXA },
                        shading: { fill: breaching ? 'fee2e2' : 'dcfce7', type: ShadingType.CLEAR },
                        children: [new Paragraph({
                            alignment: AlignmentType.LEFT,
                            spacing: { before: 40, after: 40 },
                            children: [new TextRun({
                                text: breaching
                                    ? `BREACHING POLICY NORMS (${overall.breach_count || 0} flag${(overall.breach_count || 0) === 1 ? '' : 's'})`
                                    : 'WITHIN POLICY NORMS',
                                bold: true, size: 20, font: 'Arial',
                                color: breaching ? this.COLOR_DANGER : this.COLOR_SUCCESS
                            })]
                        })]
                    })
                ]}),
                new TableRow({ children: [
                    this.createHeaderCell('Decision Hint', 3500),
                    this.createDataCell(overall.decision_hint || '-', 5860)
                ]})
            ]
        }));

        // Key outputs summary
        const fmtNum = (v) => (v === null || v === undefined || isNaN(v)) ? '-' : String(v);
        const summaryRows = [
            new TableRow({ children: [
                this.createHeaderCell('Particulars', 5680),
                this.createHeaderCell('Value', 3680)
            ]})
        ];
        const addRow = (label, val, bold = false, color = '000000') => {
            summaryRows.push(new TableRow({ children: [
                this.createDataCell(label, 5680),
                this.createDataCell(val, 3680, AlignmentType.RIGHT, bold, color)
            ]}));
        };
        addRow('Income-Eligible Loan Amount', this.camLacs(summary.eligible_loan_amount), true);
        addRow('Proposed Loan Amount', this.camLacs(summary.proposed_loan), true);
        addRow('Proposed Monthly EMI', this.camLacs(summary.proposed_emi));
        addRow('Max EMI Allowed (Monthly)', this.camLacs(summary.max_emi_allowed));
        if (summary.foir_on_proposed) addRow('FOIR on Proposed', this.camPct(summary.foir_on_proposed));
        if (summary.dscr_on_proposed) addRow('DSCR on Proposed', fmtNum(summary.dscr_on_proposed) + 'x');
        addRow('Valuation Considered', this.camLacs(summary.valuation_considered));
        addRow('Eligible LTV', this.camPct(summary.eligible_ltv));
        addRow('LTV on Proposed Loan', this.camPct(summary.ltv_on_proposed),
            false, (summary.ltv_deviation > 0 ? this.COLOR_DANGER : this.COLOR_SUCCESS));
        addRow('LTV Deviation', this.camPct(summary.ltv_deviation),
            true, (summary.ltv_deviation > 0 ? this.COLOR_DANGER : this.COLOR_SUCCESS));
        out.push(new Table({ columnWidths: [5680, 3680], rows: summaryRows }));

        // Full calculation steps
        if (Array.isArray(cam.steps) && cam.steps.length) {
            out.push(new Paragraph({
                spacing: { before: 150, after: 60 },
                children: [new TextRun({ text: 'Eligibility Calculation Working', size: 20, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })]
            }));
            const stepRows = [
                new TableRow({ children: [
                    this.createHeaderCell('Particulars', 4200),
                    this.createHeaderCell('Formula', 3000),
                    this.createHeaderCell('Value', 2160)
                ]})
            ];
            cam.steps.forEach(s => {
                stepRows.push(new TableRow({ children: [
                    this.createDataCell(s.label, 4200),
                    this.createDataCell(s.formula || '-', 3000),
                    this.createDataCell(s.value_display != null ? s.value_display : fmtNum(s.value), 2160, AlignmentType.RIGHT)
                ]}));
            });
            out.push(new Table({ columnWidths: [4200, 3000, 2160], rows: stepRows }));
        }

        // Policy condition checklist
        if (Array.isArray(cam.policy_checks) && cam.policy_checks.length) {
            out.push(new Paragraph({
                spacing: { before: 150, after: 60 },
                children: [new TextRun({ text: 'Policy Conditions & Flags', size: 20, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })]
            }));
            const checkRows = [
                new TableRow({ children: [
                    this.createHeaderCell('Condition', 6100),
                    this.createHeaderCell('Norm', 1800),
                    this.createHeaderCell('Status', 1460)
                ]})
            ];
            cam.policy_checks.forEach(c => {
                checkRows.push(new TableRow({ children: [
                    this.createDataCell(c.label, 6100),
                    this.createDataCell(c.norm || 'Required', 1800, AlignmentType.CENTER),
                    this.createStatusCell(c.complied ? 'pass' : 'fail', 1460)
                ]}));
            });
            out.push(new Table({ columnWidths: [6100, 1800, 1460], rows: checkRows }));
        }

        // Breach flags
        if (Array.isArray(cam.flags) && cam.flags.length) {
            out.push(new Paragraph({
                spacing: { before: 120, after: 40 },
                children: [new TextRun({ text: 'Deviation Flags:', size: 18, bold: true, font: 'Arial', color: this.COLOR_DANGER })]
            }));
            cam.flags.forEach(f => {
                out.push(new Paragraph({
                    spacing: { after: 20 },
                    children: [new TextRun({ text: `• ${this.sanitizeText(f)}`, size: 18, font: 'Arial', color: this.COLOR_DANGER })]
                }));
            });
        }

        return out;
    }

    /** Format a Lakhs value for the CAM section. */
    camLacs(lacs) {
        if (lacs === null || lacs === undefined || isNaN(lacs)) return '-';
        const sign = lacs < 0 ? '-' : '';
        const abs = Math.abs(lacs);
        if (abs >= 100) return `${sign}₹${(abs / 100).toFixed(2)} Cr`;
        return `${sign}₹${abs.toFixed(2)} L`;
    }

    /** Format a decimal fraction as a percentage for the CAM section. */
    camPct(frac) {
        if (frac === null || frac === undefined || isNaN(frac)) return '-';
        return `${(frac * 100).toFixed(2)}%`;
    }
}

module.exports = new DocxGenerator();
