/* =====================================================================
   Mateen VapeLounge - Staff dashboard logic
   No financial totals. No costs, no profit. Backend enforces the rest.
   ===================================================================== */

(function () {
    'use strict';

    const MV = window.MV;
    const $  = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    let me = null;
    let allCategories = [];        // every category from API
    let refillCategories = [];     // categories that contain refillable products
    let saleCategories = [];       // categories with at least one product
    let products = [];             // every active product (with category/brand)
    let refillSizes = [];

    // =================================================================
    // Boot
    // =================================================================
    document.addEventListener('DOMContentLoaded', async () => {
        try { me = await MV.requireAuth('staff'); } catch (_) { return; }
        $('#staffName').textContent = me.name;
        $('#staffInitials').textContent = MV.initials(me.name);

        bindTopbar();
        bindActionToggle();
        bindRefillForm();
        bindSaleForm();

        await refreshAll();
    });

    function bindTopbar() {
        $('#logoutBtn').addEventListener('click', () => MV.logout());
        $('#themeToggle').addEventListener('click', () => MV.toggleTheme());
    }

    function bindActionToggle() {
        $$('.action-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const action = tab.dataset.action;
                $$('.action-tab').forEach(t => t.classList.toggle('active', t === tab));
                $('#refillCard').classList.toggle('hide', action !== 'refill');
                $('#saleCard').classList.toggle('hide', action !== 'sale');
            });
        });
    }

    async function refreshAll() {
        await Promise.all([loadProducts(), loadRefillSizes()]);
        await Promise.all([loadActivity()]);
        renderStockGroups();
        populateRefillCategories();
        populateSaleCategories();
    }

    // =================================================================
    // Data loaders
    // =================================================================
    async function loadProducts() {
        const data = await MV.api('/api/products');
        products = data.products || [];

        // Build category lists
        const seenAll = new Map();
        const seenRefill = new Map();
        const seenSale = new Map();
        for (const p of products) {
            if (!seenAll.has(p.category_id)) {
                seenAll.set(p.category_id, { id: p.category_id, name: p.category_name });
            }
            seenSale.set(p.category_id, { id: p.category_id, name: p.category_name });
            if (p.is_refillable && p.price_per_ml != null) {
                seenRefill.set(p.category_id, { id: p.category_id, name: p.category_name });
            }
        }
        allCategories = Array.from(seenAll.values()).sort((a, b) => a.name.localeCompare(b.name));
        saleCategories = Array.from(seenSale.values()).sort((a, b) => a.name.localeCompare(b.name));
        refillCategories = Array.from(seenRefill.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    async function loadRefillSizes() {
        const data = await MV.api('/api/refill-sizes');
        refillSizes = (data.refill_sizes || []).filter(r => r.is_active);
    }

    async function loadActivity() {
        const root = $('#myActivityBody');
        try {
            const data = await MV.api('/api/transactions/recent?limit=50');
            const tx = (data.transactions || []);
            const refillCount = tx.filter(t => t.kind === 'refill').length;
            const saleCount = tx.filter(t => t.kind === 'sale').length;
            const units = tx.filter(t => t.kind === 'sale')
                .reduce((a, t) => a + (Number(t.quantity) || 0), 0);
            const ml = tx.filter(t => t.kind === 'refill')
                .reduce((a, t) => a + (Number(t.ml_amount) || 0), 0);

            $('#myRefillsCount').textContent = MV.fmtNum(refillCount);
            $('#mySalesCount').textContent = MV.fmtNum(saleCount);
            $('#myUnits').textContent = MV.fmtNum(units);
            $('#myMl').textContent = MV.fmtNum(ml, 1);

            if (!tx.length) {
                root.innerHTML = '<div class="empty-state">' +
                    '<div class="empty-icon">' +
                    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
                    '</div>' +
                    '<div class="empty-title">No activity yet today</div>' +
                    '<div class="empty-sub">Refills and sales will appear here</div></div>';
                return;
            }

            root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
                '<th>Time</th><th>Type</th><th>Product</th><th class="num">Detail</th>' +
                '</tr></thead><tbody>' +
                tx.map(t => {
                    const isSale = t.kind === 'sale';
                    const detail = isSale
                        ? `${t.quantity} unit${t.quantity > 1 ? 's' : ''}`
                        : `${MV.fmtNum(t.ml_amount, 1)}ml · ${MV.escHtml(t.refill_label)}`;
                    return `
                        <tr>
                            <td class="muted font-mono">${MV.fmtTime(t.at)}</td>
                            <td>${isSale ? '<span class="badge badge-amber badge-dot">Sale</span>'
                                          : '<span class="badge badge-info badge-dot">Refill</span>'}</td>
                            <td>
                                <strong>${MV.escHtml(t.product_name)}</strong>
                                <div class="muted" style="font-size:11px">${MV.escHtml(t.brand_name)}</div>
                            </td>
                            <td class="num">${detail}</td>
                        </tr>`;
                }).join('') +
                '</tbody></table></div>';
        } catch (e) {
            root.innerHTML = '<div class="empty-state">' +
                '<div class="empty-title">Could not load activity</div>' +
                '<div class="empty-sub">' + MV.escHtml(e.message) + '</div></div>';
        }
    }

    // =================================================================
    // Stock overview (grouped by category, no prices)
    // =================================================================
    function renderStockGroups() {
        const root = $('#stockGroups');
        if (!products.length) {
            root.innerHTML = '<div class="empty-state">' +
                '<div class="empty-title">No products available</div>' +
                '<div class="empty-sub">Owner has not added products yet</div></div>';
            return;
        }

        // Group: category -> brand -> [products]
        const tree = new Map();
        for (const p of products) {
            if (!tree.has(p.category_id)) {
                tree.set(p.category_id, {
                    id: p.category_id, name: p.category_name, brands: new Map(),
                });
            }
            const cat = tree.get(p.category_id);
            if (!cat.brands.has(p.brand_id)) {
                cat.brands.set(p.brand_id, { id: p.brand_id, name: p.brand_name, products: [] });
            }
            cat.brands.get(p.brand_id).products.push(p);
        }

        const cats = Array.from(tree.values()).sort((a, b) => a.name.localeCompare(b.name));
        root.innerHTML = cats.map(cat => {
            const brands = Array.from(cat.brands.values()).sort((a, b) => a.name.localeCompare(b.name));
            const totalProducts = brands.reduce((a, b) => a + b.products.length, 0);
            const lowCount = brands.reduce((a, b) =>
                a + b.products.filter(p => p.low_stock || p.stock_quantity <= 0).length, 0);
            const lowBadge = lowCount
                ? `<span class="badge badge-danger badge-dot">${lowCount} low</span>`
                : '';
            return `
                <details class="stock-group" open>
                    <summary class="stock-group-head">
                        <span class="caret">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </span>
                        <span class="cat-name">${MV.escHtml(cat.name)}</span>
                        <span class="muted">${totalProducts} product${totalProducts === 1 ? '' : 's'}</span>
                        <span style="margin-left:auto">${lowBadge}</span>
                    </summary>
                    <div class="stock-group-body">
                        ${brands.map(b => `
                            <div class="brand-block">
                                <div class="brand-head">${MV.escHtml(b.name)}</div>
                                <div class="stock-grid">
                                    ${b.products.map(p => {
                                        let cls = '';
                                        if (p.stock_quantity <= 0) cls = 'zero';
                                        else if (p.low_stock) cls = 'low';
                                        const badge = p.stock_quantity <= 0
                                            ? '<span class="badge badge-danger badge-dot">Out</span>'
                                            : (p.low_stock
                                                ? '<span class="badge badge-danger badge-dot">Low</span>'
                                                : '<span class="badge badge-success badge-dot">In Stock</span>');
                                        const refBadge = p.is_refillable
                                            ? '<span class="badge badge-info" style="font-size:10px">Refillable</span>'
                                            : '';
                                        return `<div class="stock-card">
                                            <div class="row-top">
                                                <div class="name">${MV.escHtml(p.name)}</div>
                                                ${refBadge}
                                            </div>
                                            <div class="stock-num ${cls}">${p.stock_quantity}</div>
                                            <div class="stock-meta">
                                                <span>Units in stock</span>
                                                ${badge}
                                            </div>
                                        </div>`;
                                    }).join('')}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </details>
            `;
        }).join('');
    }

    // =================================================================
    // REFILL flow (cascading dropdowns)
    // =================================================================
    function bindRefillForm() {
        $('#refillCategory').addEventListener('change', () => {
            const cid = parseInt($('#refillCategory').value, 10);
            const brSel = $('#refillBrand');
            $('#refillProduct').innerHTML = '<option value="">— Select brand first —</option>';
            $('#refillProduct').disabled = true;
            $('#refillSize').innerHTML = '<option value="">— Select product first —</option>';
            $('#refillSize').disabled = true;
            updateRefillCalc();
            if (!cid) {
                brSel.innerHTML = '<option value="">— Select category first —</option>';
                brSel.disabled = true;
                return;
            }
            const brands = brandsForCategory(cid, /*refillable*/ true);
            brSel.disabled = !brands.length;
            brSel.innerHTML = brands.length
                ? '<option value="">— Select brand —</option>' + brands.map(b =>
                    `<option value="${b.id}">${MV.escHtml(b.name)}</option>`).join('')
                : '<option value="">No refillable brands in this category</option>';
        });

        $('#refillBrand').addEventListener('change', () => {
            const bid = parseInt($('#refillBrand').value, 10);
            const prSel = $('#refillProduct');
            $('#refillSize').innerHTML = '<option value="">— Select product first —</option>';
            $('#refillSize').disabled = true;
            updateRefillCalc();
            if (!bid) {
                prSel.innerHTML = '<option value="">— Select brand first —</option>';
                prSel.disabled = true;
                return;
            }
            const list = products.filter(p => p.brand_id === bid && p.is_refillable && p.price_per_ml != null);
            prSel.disabled = !list.length;
            prSel.innerHTML = list.length
                ? '<option value="">— Select product —</option>' + list.map(p =>
                    `<option value="${p.id}" data-ppml="${p.price_per_ml}">${MV.escHtml(p.name)} · PKR ${Number(p.price_per_ml).toFixed(2)}/ml</option>`).join('')
                : '<option value="">No refillable products in this brand</option>';
        });

        $('#refillProduct').addEventListener('change', () => {
            const pid = parseInt($('#refillProduct').value, 10);
            const szSel = $('#refillSize');
            updateRefillCalc();
            if (!pid) {
                szSel.innerHTML = '<option value="">— Select product first —</option>';
                szSel.disabled = true;
                return;
            }
            if (!refillSizes.length) {
                szSel.innerHTML = '<option value="">No refill sizes configured — ask the owner</option>';
                szSel.disabled = true;
                return;
            }
            szSel.disabled = false;
            szSel.innerHTML = '<option value="">— Select size —</option>' + refillSizes.map(r =>
                `<option value="${r.id}" data-ml="${r.ml_amount}">${MV.escHtml(r.label)} (${Number(r.ml_amount).toFixed(1)}ml)</option>`).join('');
        });

        $('#refillSize').addEventListener('change', updateRefillCalc);

        $('#refillForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#refillSubmit');
            const product_id = parseInt($('#refillProduct').value, 10);
            const refill_size_id = parseInt($('#refillSize').value, 10);
            if (!product_id || !refill_size_id) {
                showFeedback('refillFeedback', 'Complete every step', true);
                return;
            }

            MV.setBusy(submit, true);
            try {
                const r = await MV.api('/api/refills', {
                    method: 'POST',
                    body: { product_id, refill_size_id },
                });
                const productName = ($('#refillProduct').selectedOptions[0]?.textContent || '').split(' · ')[0];
                const sizeLabel = $('#refillSize').selectedOptions[0]?.textContent || '';
                showFeedback('refillFeedback', `Refill recorded — ${sizeLabel.trim()} of ${productName}`);
                MV.toast('Refill recorded', 'success');

                // Reset
                $('#refillCategory').value = '';
                $('#refillCategory').dispatchEvent(new Event('change'));
                await loadActivity();
            } catch (e) {
                showFeedback('refillFeedback', e.message || 'Failed to record refill', true);
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    function updateRefillCalc() {
        const pOpt = $('#refillProduct').selectedOptions[0];
        const sOpt = $('#refillSize').selectedOptions[0];
        const ppml = pOpt && pOpt.dataset.ppml ? Number(pOpt.dataset.ppml) : null;
        const ml   = sOpt && sOpt.dataset.ml   ? Number(sOpt.dataset.ml)   : null;

        if (ppml != null && ml != null) {
            $('#refillCalcMl').textContent = ml.toFixed(1) + ' ml';
            $('#refillCalcPpml').textContent = MV.fmtPKR(ppml);
            $('#refillCalcTotal').textContent = MV.fmtPKR(ppml * ml);
            $('#refillSubmit').disabled = false;
        } else {
            $('#refillCalcMl').textContent = '—';
            $('#refillCalcPpml').textContent = '—';
            $('#refillCalcTotal').textContent = '—';
            $('#refillSubmit').disabled = true;
        }
    }

    function populateRefillCategories() {
        const sel = $('#refillCategory');
        if (!refillCategories.length) {
            sel.innerHTML = '<option value="">No refillable products available</option>';
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        sel.innerHTML = '<option value="">— Select category —</option>' +
            refillCategories.map(c => `<option value="${c.id}">${MV.escHtml(c.name)}</option>`).join('');
    }

    // =================================================================
    // SALE flow (cascading dropdowns)
    // =================================================================
    function bindSaleForm() {
        $('#saleCategory').addEventListener('change', () => {
            const cid = parseInt($('#saleCategory').value, 10);
            const brSel = $('#saleBrand');
            $('#saleProduct').innerHTML = '<option value="">— Select brand first —</option>';
            $('#saleProduct').disabled = true;
            $('#saleQty').disabled = true;
            $('#saleQty').value = '';
            updateSaleCalc();
            if (!cid) {
                brSel.innerHTML = '<option value="">— Select category first —</option>';
                brSel.disabled = true;
                return;
            }
            const brands = brandsForCategory(cid, /*refillable*/ false);
            brSel.disabled = !brands.length;
            brSel.innerHTML = brands.length
                ? '<option value="">— Select brand —</option>' + brands.map(b =>
                    `<option value="${b.id}">${MV.escHtml(b.name)}</option>`).join('')
                : '<option value="">No products in this category</option>';
        });

        $('#saleBrand').addEventListener('change', () => {
            const bid = parseInt($('#saleBrand').value, 10);
            const prSel = $('#saleProduct');
            $('#saleQty').disabled = true;
            $('#saleQty').value = '';
            updateSaleCalc();
            if (!bid) {
                prSel.innerHTML = '<option value="">— Select brand first —</option>';
                prSel.disabled = true;
                return;
            }
            const list = products.filter(p => p.brand_id === bid);
            prSel.disabled = !list.length;
            prSel.innerHTML = list.length
                ? '<option value="">— Select product —</option>' + list.map(p =>
                    `<option value="${p.id}" data-stock="${p.stock_quantity}">${MV.escHtml(p.name)} · stock ${p.stock_quantity}</option>`).join('')
                : '<option value="">No products in this brand</option>';
        });

        $('#saleProduct').addEventListener('change', () => {
            const opt = $('#saleProduct').selectedOptions[0];
            const stock = opt && opt.dataset.stock ? parseInt(opt.dataset.stock, 10) : 0;
            const qty = $('#saleQty');
            if (!opt || !opt.value) {
                qty.disabled = true;
                qty.value = '';
            } else if (stock <= 0) {
                qty.disabled = true;
                qty.value = '';
            } else {
                qty.disabled = false;
                qty.max = stock;
                qty.value = '1';
                qty.focus();
                qty.select();
            }
            updateSaleCalc();
        });

        $('#saleQty').addEventListener('input', updateSaleCalc);

        $('#saleForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#saleSubmit');
            const product_id = parseInt($('#saleProduct').value, 10);
            const quantity = parseInt($('#saleQty').value, 10);
            if (!product_id || !(quantity >= 1)) {
                showFeedback('saleFeedback', 'Complete every step', true);
                return;
            }
            const opt = $('#saleProduct').selectedOptions[0];
            const stock = opt && opt.dataset.stock ? parseInt(opt.dataset.stock, 10) : 0;
            if (quantity > stock) {
                showFeedback('saleFeedback', `Only ${stock} available`, true);
                return;
            }

            MV.setBusy(submit, true);
            try {
                await MV.api('/api/sales', {
                    method: 'POST',
                    body: { product_id, quantity },
                });
                const productName = (opt.textContent || '').split(' · ')[0];
                showFeedback('saleFeedback', `Sale recorded — ${quantity} × ${productName}`);
                MV.toast('Sale recorded', 'success');

                $('#saleCategory').value = '';
                $('#saleCategory').dispatchEvent(new Event('change'));
                await Promise.all([loadProducts(), loadActivity()]);
                renderStockGroups();
                populateSaleCategories();
                populateRefillCategories();
            } catch (e) {
                showFeedback('saleFeedback', e.message || 'Failed to record sale', true);
                if (e.data && typeof e.data.available === 'number') {
                    await loadProducts();
                    renderStockGroups();
                }
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    function updateSaleCalc() {
        const opt = $('#saleProduct').selectedOptions[0];
        const stock = opt && opt.dataset.stock ? parseInt(opt.dataset.stock, 10) : null;
        const qty = parseInt($('#saleQty').value, 10);

        $('#saleCalcStock').textContent = stock != null ? stock : '—';
        $('#saleCalcQty').textContent = qty >= 1 ? qty : '—';

        if (stock == null) {
            $('#saleCalcStatus').textContent = '—';
            $('#saleSubmit').disabled = true;
            $('#saleCalcStatus').className = 'calc-value total-value';
        } else if (stock <= 0) {
            $('#saleCalcStatus').textContent = 'OUT OF STOCK';
            $('#saleCalcStatus').className = 'calc-value total-value text-danger';
            $('#saleSubmit').disabled = true;
        } else if (!(qty >= 1)) {
            $('#saleCalcStatus').textContent = 'Enter a quantity';
            $('#saleCalcStatus').className = 'calc-value total-value';
            $('#saleSubmit').disabled = true;
        } else if (qty > stock) {
            $('#saleCalcStatus').textContent = `Exceeds stock (max ${stock})`;
            $('#saleCalcStatus').className = 'calc-value total-value text-danger';
            $('#saleSubmit').disabled = true;
        } else {
            $('#saleCalcStatus').textContent = 'Ready';
            $('#saleCalcStatus').className = 'calc-value total-value text-success';
            $('#saleSubmit').disabled = false;
        }
    }

    function populateSaleCategories() {
        const sel = $('#saleCategory');
        if (!saleCategories.length) {
            sel.innerHTML = '<option value="">No products available</option>';
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        sel.innerHTML = '<option value="">— Select category —</option>' +
            saleCategories.map(c => `<option value="${c.id}">${MV.escHtml(c.name)}</option>`).join('');
    }

    // =================================================================
    // Helpers
    // =================================================================
    function brandsForCategory(catId, refillableOnly) {
        const map = new Map();
        for (const p of products) {
            if (p.category_id !== catId) continue;
            if (refillableOnly && (!p.is_refillable || p.price_per_ml == null)) continue;
            if (!map.has(p.brand_id)) {
                map.set(p.brand_id, { id: p.brand_id, name: p.brand_name });
            }
        }
        return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    function showFeedback(targetId, msg, isError) {
        const fb = $('#' + targetId);
        fb.textContent = msg;
        fb.classList.toggle('error', !!isError);
        fb.classList.add('show');
        if (!isError) {
            setTimeout(() => fb.classList.remove('show'), 4000);
        }
    }
})();
