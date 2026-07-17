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
            children: [new TextRun({ text: `Generated on ${new Date().toLocaleString('en-IN')} | Axis Finance Limited`, size: 16, color: '666666', font: 'Arial' })]
        }));

        const doc = new Document({
            styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
            sections: [{
                properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
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
        const out = [];
        const p   = assessment.pennant_data || {};
        const cust = p.customer || {};
        const loan = p.loanDetail || {};
        const collateral = p.collateral || [];
        const cam = assessment.cam_eligibility || assessment.calculations?.cam_eligibility || {};
        const camSummary = cam.summary || {};

        const V = (val) => (val === null || val === undefined || val === '') ? '' : String(val);
        const label = (t) => this.createDataCell(t, 3200, AlignmentType.LEFT, true, '000000');
        const value = (t) => this.createDataCell(V(t), 6160, AlignmentType.LEFT, false);
        const sectionHeader = (t) => new TableRow({ children: [
            new TableCell({
                borders: this.createCellBorders(),
                columnSpan: 2,
                width: { size: 9360, type: WidthType.DXA },
                shading: { fill: this.COLOR_PRIMARY, type: ShadingType.CLEAR },
                children: [new Paragraph({ spacing: { before: 40, after: 40 },
                    children: [new TextRun({ text: t, bold: true, size: 20, font: 'Arial', color: 'FFFFFF' })] })]
            })
        ]});
        const row = (l, v) => new TableRow({ children: [label(l), value(v)] });

        // ===== Title =====
        out.push(new Paragraph({
            spacing: { before: 300, after: 60 }, alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: 'CREDIT ASSESSMENT MEMORANDUM (CAM)', size: 28, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })]
        }));
        out.push(new Paragraph({
            spacing: { after: 200 }, alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `Date: ${new Date(assessment.created_at || Date.now()).toLocaleDateString('en-IN')}`, size: 18, font: 'Arial' })]
        }));

        // ===== PART A — Client Details =====
        out.push(new Paragraph({ spacing: { before: 200, after: 80 },
            children: [new TextRun({ text: "Part A' – Client Details", size: 22, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] }));

        out.push(new Table({ columnWidths: [3200, 6160], rows: [
            row('Borrower Company (Customer Full Name)', cust.name),
            row('Customer Details', cust.customerCode || cust.custCif),
            row('Borrower UCIC No.', loan.ucic),
            row('Address', [cust.address, cust.city, cust.state].filter(Boolean).join(', ')),
            row('Phone Number', cust.phone),           // Pennant PHONENUMBER
            row('Email', cust.email),                  // Pennant CUSTEMAIL
            row('LEI No.', cust.lei),                  // Pennant LEICODE
            row('LEI Expiry Date', cust.leiExpiry),    // Pennant LEIEXPDT
            row('CIN', cust.cin),                      // Pennant CIN
            row('Date of Incorporation', cust.incorporationDate),  // Pennant CUSTDOB
            row('Listed / Unlisted', cust.listedStatus),
            row('Account Status', cust.dealingsSince),
            row('Group', cust.group),
            row('Internal Rating', cust.internalRating),   // Loan Extended Field
            row('External Rating', cust.externalRating),   // Loan Extended Field
            row('Type of Facility', loan.loanType),        // Pennant LOAN_TYPE
            row('KYC Category', cust.customerCategory),     // Pennant CUSTOMER_CATEGORY
            row('Sourcing Officer', cust.sourcingOfficer),  // Pennant SOURCING_OFFICER
            row('CKYC Number', cust.ckycNo),                // Pennant CKYCNO
            row('Secured / Unsecured', cust.securedUnsecured),
            row('Category', cust.category),
            row('RBI Industry Code', cust.industry),
            row('Banking Arrangement', cust.bankingArrangement),
            row('MSME Tagging', cust.msmeFlag),             // Pennant msmeflag
            row('Sector', cust.sectorDesc),                 // Pennant SECTORDESC
            row('Sub Sector', cust.subSector),              // Pennant SUBSECTOR
            sectionHeader('Shareholder Details'),
            row('Shareholder Details', cust.shareholderDetails),
            sectionHeader('Exposure & Relationship (from Loan Queue)'),
            row('Relationship with Axis Bank', cust.axisRelationship),
            row('Existing Loan Exposure with AFL', cust.existingExposure),
            row('External Liabilities', cust.externalLiabilities),
            row('Single Borrower & Group Exposure', cust.groupExposure),
            row('CRILC', cust.crilc)
        ]}));

        // ===== PART B — Proposal Details =====
        out.push(new Paragraph({ spacing: { before: 300, after: 80 },
            children: [new TextRun({ text: "Part B' – Proposal Details", size: 22, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] }));

        const eligibleAmt = camSummary.eligible_loan_amount_lakhs != null ? `Rs. ${camSummary.eligible_loan_amount_lakhs} Lakhs` : '';
        const proposedAmt = camSummary.proposed_loan_lakhs != null ? `Rs. ${camSummary.proposed_loan_lakhs} Lakhs` : (loan.financeAmount ? `Rs. ${loan.financeAmount}` : '');
        const emi = camSummary.proposed_emi != null ? `Rs. ${camSummary.proposed_emi}` : '';

        out.push(new Table({ columnWidths: [3200, 6160], rows: [
            row('Basic Loan Details', [loan.product, loan.loanType].filter(Boolean).join(' — ')),
            row('Finance Amount (Pennant)', loan.financeAmount ? `Rs. ${loan.financeAmount}` : ''),
            row('Tenure (months)', loan.tenureMonths),
            row('Interest Rate Type', loan.interestRateType),
            row('Maturity Date', loan.maturityDate),
            sectionHeader('Eligibility (Calculation Engine)'),
            row('Eligibility Program', cam.program_label || cam.program),
            row('Eligible Loan Amount (ELA)', eligibleAmt),
            row('Proposed Loan Amount', proposedAmt),
            row('Proposed Monthly EMI', emi),
            row('Moratorium Period', ''),   // AFL user manual entry
            row('Payment Details', ''),     // AFL user manual entry
            sectionHeader('From Loan Queue (AFL user / Pennant)'),
            row('Co-Applicant Details', ''),
            row('Guarantor Details', ''),
            row('Custom Deviations Details', ''),
            row('Security / Collateral Details', collateral.length
                ? collateral.map(c => `${c.collateralType || ''} (Assigned: ${c.assignedValue || '-'})`).join('; ')
                : ''),
            row('Put / Call', ''),
            row('DCCO', '')
        ]}));

        // ===== ANNEXURE II — Repayment Schedule =====
        out.push(new Paragraph({ spacing: { before: 300, after: 80 },
            children: [new TextRun({ text: 'Annexure – II : Repayment Schedule', size: 22, bold: true, font: 'Arial', color: this.COLOR_PRIMARY })] }));

        const rps = assessment.repayment_schedule || cam.repayment_schedule || [];
        const rpsRows = [ new TableRow({ children: [
            this.createHeaderCell('Instalment No', 1600),
            this.createHeaderCell('Date', 2000),
            this.createHeaderCell('Interest', 1920),
            this.createHeaderCell('Principal', 1920),
            this.createHeaderCell('Repayment Amount', 1920)
        ]})];

        if (rps.length) {
            rps.forEach((r, i) => rpsRows.push(new TableRow({ children: [
                this.createDataCell(V(r.instalment_no || (i + 1)), 1600, AlignmentType.CENTER),
                this.createDataCell(V(r.date), 2000, AlignmentType.CENTER),
                this.createDataCell(V(r.interest), 1920, AlignmentType.RIGHT),
                this.createDataCell(V(r.principal), 1920, AlignmentType.RIGHT),
                this.createDataCell(V(r.repayment_amount), 1920, AlignmentType.RIGHT)
            ]})));
        } else {
            rpsRows.push(new TableRow({ children: [
                new TableCell({ borders: this.createCellBorders(), columnSpan: 5,
                    width: { size: 9360, type: WidthType.DXA },
                    children: [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 },
                        children: [new TextRun({ text: 'Repayment schedule to be fetched from Loan Queue', italics: true, size: 18, font: 'Arial', color: '999999' })] })] })
            ]}));
        }
        out.push(new Table({ columnWidths: [1600, 2000, 1920, 1920, 1920], rows: rpsRows }));

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
