/* =====================================================================
   Mateen VapeLounge - Owner dashboard logic
   Category -> Brand -> Product hierarchy + refill services.
   ===================================================================== */

(function () {
    'use strict';

    const MV = window.MV;
    const $  = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    // ----- Cached state -----
    let me = null;
    let categories = [];
    let brandsByCat = {};       // category_id -> [brands]
    let productsByBrand = {};   // brand_id -> [products]
    let refillSizes = [];

    let selectedCategoryId = null;
    let selectedBrandId = null;

    let editingProductId = null;
    let editingCategoryId = null;
    let editingBrandId = null;
    let editingRefillSizeId = null;

    let auditPage = 1;
    let auditTotalPages = 1;
    let currentTab = 'overview';

    // =================================================================
    // Boot
    // =================================================================
    document.addEventListener('DOMContentLoaded', async () => {
        try { me = await MV.requireAuth('owner'); } catch (_) { return; }

        $('#userName').textContent = me.name;
        $('#userInitials').textContent = MV.initials(me.name);

        bindNav();
        bindTopbar();
        bindCategoryUI();
        bindBrandUI();
        bindProductUI();
        bindRefillSizeUI();
        bindPurchaseUI();
        bindStaffUI();
        bindAuditUI();
        bindResetUI();
        bindModals();

        await Promise.all([
            loadCategories(),
            loadStats(),
        ]);
        switchTab('overview');
    });

    // =================================================================
    // Navigation
    // =================================================================
    function bindNav() {
        $$('.nav-link').forEach(a => {
            a.addEventListener('click', e => {
                e.preventDefault();
                switchTab(a.dataset.tab);
            });
        });
        $('#logoutBtn').addEventListener('click', () => MV.logout());

        const menu = $('#menuToggle'), sb = $('#sidebar'), bd = $('#sidebarBackdrop');
        if (menu && sb && bd) {
            menu.addEventListener('click', () => {
                sb.classList.toggle('open');
                bd.classList.toggle('active');
            });
            bd.addEventListener('click', () => {
                sb.classList.remove('open');
                bd.classList.remove('active');
            });
        }
    }

    function switchTab(tab) {
        currentTab = tab;
        $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
        $$('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));

        const titles = {
            overview:        ['Overview',     'Today at a glance'],
            products:        ['Products',     'Category · Brand · Product'],
            'refill-sizes':  ['Refill Sizes', 'Master list of refill volumes'],
            purchases:       ['Purchases',    'Restock & supplier history'],
            staff:           ['Staff',        'Team management'],
            audit:           ['Audit Log',    'Every action, every IP'],
            settings:        ['Settings',     'Danger zone'],
        };
        const [t, c] = titles[tab] || ['Dashboard', ''];
        $('#pageTitle').textContent = t;
        $('#pageCrumb').textContent = c;

        $('#statsGrid').classList.toggle('hide', tab !== 'overview');

        if (tab === 'overview')      refreshOverview();
        if (tab === 'products')      refreshProductsTab();
        if (tab === 'refill-sizes')  loadRefillSizes();
        if (tab === 'purchases')     refreshPurchasesTab();
        if (tab === 'staff')         loadStaff();
        if (tab === 'audit')         loadAudit(1);

        const sb = $('#sidebar'), bd = $('#sidebarBackdrop');
        if (sb && bd) { sb.classList.remove('open'); bd.classList.remove('active'); }
    }

    function bindTopbar() {
        $('#themeToggle').addEventListener('click', () => MV.toggleTheme());
        $('#notifBtn').addEventListener('click', () => switchTab('products'));
    }

    // =================================================================
    // Stats / overview
    // =================================================================
    async function refreshOverview() {
        await Promise.all([
            loadStats(),
            loadRecentTransactions(),
        ]);
    }

    async function loadStats() {
        try {
            const s = await MV.api('/api/dashboard/stats');

            $('#statTotalRevenue').innerHTML =
                `<span class="currency">PKR</span>${MV.fmtNum(s.today_total_revenue)}`;
            $('#statProductRevenue').innerHTML =
                `<span class="currency">PKR</span>${MV.fmtNum(s.today_product_sales_total)}`;
            $('#statRefillRevenue').innerHTML =
                `<span class="currency">PKR</span>${MV.fmtNum(s.today_refill_revenue)}`;
            $('#statStockValue').innerHTML =
                `<span class="currency">PKR</span>${MV.fmtNum(s.total_stock_value)}`;
            $('#statLow').textContent = MV.fmtNum((s.low_stock_products || []).length);

            $('#footTotalCount').textContent = `${MV.fmtNum(s.today_total_count)} transactions`;
            $('#footProductCount').textContent = `${MV.fmtNum(s.today_product_sales_count)} sales`;
            $('#footRefillCount').textContent = `${MV.fmtNum(s.today_refill_count)} refills`;
            $('#footProfit').textContent = 'Potential profit: ' + MV.fmtPKR(s.total_profit_potential);
            $('#footStaff').textContent = `${MV.fmtNum(s.active_staff_count)} active staff`;

            const dot = $('#notifDot');
            const cnt = (s.low_stock_products || []).length;
            dot.classList.toggle('show', cnt > 0);

            const lowBadge = $('#sidebarLowCount');
            if (lowBadge) {
                if (cnt > 0) {
                    lowBadge.textContent = cnt;
                    lowBadge.classList.remove('hide');
                } else {
                    lowBadge.classList.add('hide');
                }
            }

            renderLowStock(s.low_stock_products || []);
            renderTopSelling(s.top_selling_today || []);
            renderTopRefills(s.top_refills_today || []);
        } catch (e) {
            MV.toast('Failed to load stats: ' + e.message, 'error');
        }
    }

    function renderLowStock(items) {
        const root = $('#lowStockBody');
        if (!items.length) {
            root.innerHTML = emptyState('All stocked up', 'Nothing below threshold');
            return;
        }
        root.innerHTML = '<div class="low-stock-list">' + items.map(p => `
            <div class="low-stock-row">
                <div class="ls-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                </div>
                <div class="ls-name">
                    <strong>${MV.escHtml(p.name)}</strong>
                    <div class="muted" style="font-size:11px">${MV.escHtml(p.category_name)} · ${MV.escHtml(p.brand_name)}</div>
                </div>
                <div class="ls-stock">${p.stock_quantity} / ${p.low_stock_threshold}</div>
            </div>`).join('') + '</div>';
    }

    function renderTopSelling(items) {
        const root = $('#topSellingBody');
        if (!items.length) {
            root.innerHTML = emptyState('No sales yet today', 'Top sellers appear after the first sale');
            return;
        }
        root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
            '<th>Product</th><th class="num">Qty</th><th class="num">Revenue</th>' +
            '</tr></thead><tbody>' +
            items.map(t => `
                <tr>
                    <td><strong>${MV.escHtml(t.name)}</strong>
                        <div class="muted" style="font-size:11px">${MV.escHtml(t.brand_name)}</div></td>
                    <td class="num">${MV.fmtNum(t.qty)}</td>
                    <td class="num">${MV.fmtPKR(t.revenue)}</td>
                </tr>`).join('') +
            '</tbody></table></div>';
    }

    function renderTopRefills(items) {
        const root = $('#topRefillsBody');
        if (!items.length) {
            root.innerHTML = emptyState('No refills yet today', 'Refill activity appears here');
            return;
        }
        root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
            '<th>Product</th><th class="num">Refills</th><th class="num">ml</th><th class="num">Revenue</th>' +
            '</tr></thead><tbody>' +
            items.map(t => `
                <tr>
                    <td><strong>${MV.escHtml(t.name)}</strong>
                        <div class="muted" style="font-size:11px">${MV.escHtml(t.brand_name)}</div></td>
                    <td class="num">${MV.fmtNum(t.cnt)}</td>
                    <td class="num">${MV.fmtNum(t.total_ml, 1)}</td>
                    <td class="num">${MV.fmtPKR(t.revenue)}</td>
                </tr>`).join('') +
            '</tbody></table></div>';
    }

    async function loadRecentTransactions() {
        const root = $('#recentTxBody');
        try {
            const data = await MV.api('/api/transactions/recent?limit=20');
            const tx = data.transactions || [];
            if (!tx.length) {
                root.innerHTML = emptyState('No transactions yet', 'Sales and refills appear here');
                return;
            }
            root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
                '<th>Time</th><th>Type</th><th>Product</th><th>Staff</th>' +
                '<th class="num">Detail</th><th class="num">Total</th>' +
                '</tr></thead><tbody>' +
                tx.map(t => {
                    const isSale = t.kind === 'sale';
                    const detail = isSale
                        ? `${t.quantity} unit${t.quantity > 1 ? 's' : ''}`
                        : `${MV.fmtNum(t.ml_amount, 1)}ml · ${MV.escHtml(t.refill_label)}`;
                    return `
                        <tr>
                            <td class="muted">${MV.fmtDate(t.at)}</td>
                            <td>${isSale ? '<span class="badge badge-amber badge-dot">SALE</span>'
                                          : '<span class="badge badge-info badge-dot">REFILL</span>'}</td>
                            <td>
                                <strong>${MV.escHtml(t.product_name)}</strong>
                                <div class="muted" style="font-size:11px">${MV.escHtml(t.brand_name)} · ${MV.escHtml(t.category_name)}</div>
                            </td>
                            <td>${MV.escHtml(t.staff_name || '—')}</td>
                            <td class="num">${detail}</td>
                            <td class="num">${MV.fmtPKR(t.total_amount)}</td>
                        </tr>`;
                }).join('') +
                '</tbody></table></div>';
        } catch (e) {
            root.innerHTML = emptyState('Could not load transactions', e.message);
        }
    }

    // =================================================================
    // Products explorer (Category → Brand → Product)
    // =================================================================
    async function refreshProductsTab() {
        await loadCategories();
        renderCategoryList();
        if (selectedCategoryId) {
            await loadBrandsFor(selectedCategoryId);
            renderBrandList();
        }
        if (selectedBrandId) {
            await loadProductsFor(selectedBrandId);
            renderProductList();
        }
    }

    async function loadCategories() {
        const data = await MV.api('/api/categories');
        categories = data.categories || [];
    }

    async function loadBrandsFor(catId) {
        const data = await MV.api('/api/brands?category_id=' + catId);
        brandsByCat[catId] = data.brands || [];
    }

    async function loadProductsFor(brandId) {
        const data = await MV.api('/api/products?brand_id=' + brandId);
        productsByBrand[brandId] = data.products || [];
    }

    function bindCategoryUI() {
        $('#addCategoryBtn').addEventListener('click', () => openCategoryModal(null));
        $('#categoryForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#categorySubmit');
            const body = {
                name: $('#categoryName').value.trim(),
                description: $('#categoryDesc').value.trim(),
            };
            if (!body.name) return MV.toast('Name is required', 'error');
            MV.setBusy(submit, true);
            try {
                if (editingCategoryId) {
                    await MV.api('/api/categories/' + editingCategoryId, { method: 'PUT', body });
                    MV.toast('Category updated', 'success');
                } else {
                    const r = await MV.api('/api/categories', { method: 'POST', body });
                    selectedCategoryId = r.id;
                    selectedBrandId = null;
                    MV.toast('Category created', 'success');
                }
                closeModal();
                await refreshProductsTab();
                await loadStats();
            } catch (e) {
                MV.toast(e.message, 'error');
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    function openCategoryModal(id) {
        editingCategoryId = id;
        const c = id ? categories.find(x => x.id === id) : null;
        $('#categoryModalTitle').textContent = c ? 'Edit Category' : 'New Category';
        $('#categorySubmitLabel').textContent = c ? 'Save changes' : 'Create category';
        $('#categoryName').value = c ? c.name : '';
        $('#categoryDesc').value = c ? (c.description || '') : '';
        openModal('categoryModal');
        setTimeout(() => $('#categoryName').focus(), 80);
    }

    function renderCategoryList() {
        const root = $('#categoryList');
        if (!categories.length) {
            root.innerHTML = emptyState('No categories', 'Click + Add to begin');
            return;
        }
        root.innerHTML = categories.map(c => {
            const active = c.id === selectedCategoryId ? ' active' : '';
            return `<div class="explorer-row${active}" data-id="${c.id}">
                <div class="explorer-row-main">
                    <div class="row-name">${MV.escHtml(c.name)}</div>
                    <div class="row-meta">${c.brand_count} brand${c.brand_count === 1 ? '' : 's'} · ${c.product_count} product${c.product_count === 1 ? '' : 's'}</div>
                </div>
                <div class="explorer-row-actions">
                    <button class="btn-icon-mini js-edit-cat" data-id="${c.id}" title="Edit">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                    </button>
                    <button class="btn-icon-mini js-del-cat text-danger" data-id="${c.id}" title="Delete">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>`;
        }).join('');

        $$('#categoryList .explorer-row').forEach(r => {
            r.addEventListener('click', e => {
                if (e.target.closest('.btn-icon-mini')) return;
                selectedCategoryId = parseInt(r.dataset.id, 10);
                selectedBrandId = null;
                $('#addBrandBtn').disabled = false;
                $('#addProductBtn').disabled = true;
                renderCategoryList();
                $('#brandList').innerHTML = '<div class="explorer-loading">Loading brands…</div>';
                $('#productList').innerHTML = emptyState('Select a brand', 'Pick a brand to see its products');
                $('#productsColTitle').textContent = 'Products';
                loadBrandsFor(selectedCategoryId).then(renderBrandList);
            });
        });
        $$('#categoryList .js-edit-cat').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); openCategoryModal(parseInt(b.dataset.id, 10)); }));
        $$('#categoryList .js-del-cat').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); deleteCategory(parseInt(b.dataset.id, 10)); }));
    }

    async function deleteCategory(id) {
        const c = categories.find(x => x.id === id);
        if (!c) return;
        if (c.brand_count > 0) {
            MV.toast(`"${c.name}" still has ${c.brand_count} brand(s). Remove them first.`, 'error');
            return;
        }
        if (!confirm(`Delete category "${c.name}"?\n\nThis cannot be undone.`)) return;
        try {
            await MV.api('/api/categories/' + id, { method: 'DELETE' });
            MV.toast('Category deleted', 'success');
            if (selectedCategoryId === id) {
                selectedCategoryId = null;
                selectedBrandId = null;
                $('#addBrandBtn').disabled = true;
                $('#addProductBtn').disabled = true;
            }
            await refreshProductsTab();
            await loadStats();
        } catch (e) {
            MV.toast(e.message, 'error');
        }
    }

    function bindBrandUI() {
        $('#addBrandBtn').addEventListener('click', () => openBrandModal(null));
        $('#brandForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#brandSubmit');
            const body = {
                category_id: parseInt($('#brandCategory').value, 10),
                name: $('#brandName').value.trim(),
                description: $('#brandDesc').value.trim(),
            };
            if (!body.category_id) return MV.toast('Pick a category', 'error');
            if (!body.name) return MV.toast('Name is required', 'error');
            MV.setBusy(submit, true);
            try {
                if (editingBrandId) {
                    await MV.api('/api/brands/' + editingBrandId, { method: 'PUT', body });
                    MV.toast('Brand updated', 'success');
                } else {
                    const r = await MV.api('/api/brands', { method: 'POST', body });
                    selectedCategoryId = body.category_id;
                    selectedBrandId = r.id;
                    MV.toast('Brand created', 'success');
                }
                closeModal();
                await refreshProductsTab();
                await loadStats();
            } catch (e) {
                MV.toast(e.message, 'error');
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    function openBrandModal(id) {
        editingBrandId = id;
        const allBrands = Object.values(brandsByCat).flat();
        const b = id ? allBrands.find(x => x.id === id) : null;
        $('#brandModalTitle').textContent = b ? 'Edit Brand' : 'New Brand';
        $('#brandSubmitLabel').textContent = b ? 'Save changes' : 'Create brand';
        const sel = $('#brandCategory');
        sel.innerHTML = categories.map(c =>
            `<option value="${c.id}">${MV.escHtml(c.name)}</option>`).join('');
        sel.value = b ? b.category_id : (selectedCategoryId || (categories[0] && categories[0].id) || '');
        $('#brandName').value = b ? b.name : '';
        $('#brandDesc').value = b ? (b.description || '') : '';
        openModal('brandModal');
        setTimeout(() => $('#brandName').focus(), 80);
    }

    function renderBrandList() {
        const root = $('#brandList');
        if (!selectedCategoryId) {
            root.innerHTML = emptyState('Select a category', 'Pick a category from the left');
            return;
        }
        const list = brandsByCat[selectedCategoryId] || [];
        if (!list.length) {
            root.innerHTML = emptyState('No brands yet', 'Click + Add to create one');
            return;
        }
        root.innerHTML = list.map(b => {
            const active = b.id === selectedBrandId ? ' active' : '';
            return `<div class="explorer-row${active}" data-id="${b.id}">
                <div class="explorer-row-main">
                    <div class="row-name">${MV.escHtml(b.name)}</div>
                    <div class="row-meta">${b.product_count} product${b.product_count === 1 ? '' : 's'}</div>
                </div>
                <div class="explorer-row-actions">
                    <button class="btn-icon-mini js-edit-brand" data-id="${b.id}" title="Edit">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
                    </button>
                    <button class="btn-icon-mini js-del-brand text-danger" data-id="${b.id}" title="Delete">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
                    </button>
                </div>
            </div>`;
        }).join('');

        $$('#brandList .explorer-row').forEach(r => {
            r.addEventListener('click', e => {
                if (e.target.closest('.btn-icon-mini')) return;
                selectedBrandId = parseInt(r.dataset.id, 10);
                $('#addProductBtn').disabled = false;
                renderBrandList();
                const brand = list.find(x => x.id === selectedBrandId);
                $('#productsColTitle').textContent = brand ? brand.name : 'Products';
                $('#productList').innerHTML = '<div class="explorer-loading">Loading products…</div>';
                loadProductsFor(selectedBrandId).then(renderProductList);
            });
        });
        $$('#brandList .js-edit-brand').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); openBrandModal(parseInt(b.dataset.id, 10)); }));
        $$('#brandList .js-del-brand').forEach(b =>
            b.addEventListener('click', e => { e.stopPropagation(); deleteBrand(parseInt(b.dataset.id, 10)); }));
    }

    async function deleteBrand(id) {
        const allBrands = Object.values(brandsByCat).flat();
        const b = allBrands.find(x => x.id === id);
        if (!b) return;
        if (b.product_count > 0) {
            MV.toast(`"${b.name}" still has ${b.product_count} product(s). Remove them first.`, 'error');
            return;
        }
        if (!confirm(`Delete brand "${b.name}"?`)) return;
        try {
            await MV.api('/api/brands/' + id, { method: 'DELETE' });
            MV.toast('Brand deleted', 'success');
            if (selectedBrandId === id) {
                selectedBrandId = null;
                $('#addProductBtn').disabled = true;
            }
            await refreshProductsTab();
            await loadStats();
        } catch (e) {
            MV.toast(e.message, 'error');
        }
    }

    // ----- Product modal -----
    function bindProductUI() {
        $('#addProductBtn').addEventListener('click', () => openProductModal(null));

        $('#productCategory').addEventListener('change', async (e) => {
            const cid = parseInt(e.target.value, 10);
            const sel = $('#productBrand');
            sel.disabled = true;
            sel.innerHTML = '<option value="">Loading…</option>';
            if (!cid) {
                sel.innerHTML = '<option value="">— Select category first —</option>';
                return;
            }
            if (!brandsByCat[cid]) {
                await loadBrandsFor(cid);
            }
            const brands = brandsByCat[cid] || [];
            if (!brands.length) {
                sel.innerHTML = '<option value="">No brands in this category — create one first</option>';
                sel.disabled = true;
            } else {
                sel.innerHTML = brands.map(b =>
                    `<option value="${b.id}">${MV.escHtml(b.name)}</option>`).join('');
                sel.disabled = false;
            }
        });

        $('#productRefillable').addEventListener('change', e => {
            const grp = $('#ppmlGroup');
            grp.classList.toggle('hide', !e.target.checked);
            if (e.target.checked) $('#productPricePerMl').focus();
        });

        $('#productForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#productSubmit');
            const isRef = $('#productRefillable').checked;
            const body = {
                brand_id: parseInt($('#productBrand').value, 10),
                name: $('#productName').value.trim(),
                description: $('#productDesc').value.trim(),
                cost_price: parseFloat($('#productCost').value),
                selling_price: parseFloat($('#productSell').value),
                stock_quantity: parseInt($('#productStock').value, 10),
                low_stock_threshold: parseInt($('#productLow').value, 10) || 5,
                is_refillable: isRef,
                price_per_ml: isRef ? parseFloat($('#productPricePerMl').value) : null,
            };
            if (!body.brand_id)         return MV.toast('Pick a brand', 'error');
            if (!body.name)             return MV.toast('Product name is required', 'error');
            if (!(body.cost_price >= 0))    return MV.toast('Enter a valid cost price', 'error');
            if (!(body.selling_price >= 0)) return MV.toast('Enter a valid selling price', 'error');
            if (!(body.stock_quantity >= 0)) return MV.toast('Enter a valid stock quantity', 'error');
            if (isRef && !(body.price_per_ml > 0))
                return MV.toast('Refillable products need a price per ml > 0', 'error');

            MV.setBusy(submit, true);
            try {
                if (editingProductId) {
                    await MV.api('/api/products/' + editingProductId, { method: 'PUT', body });
                    MV.toast('Product updated', 'success');
                } else {
                    await MV.api('/api/products', { method: 'POST', body });
                    MV.toast('Product created', 'success');
                }
                closeModal();
                if (selectedBrandId) await loadProductsFor(selectedBrandId);
                renderProductList();
                await Promise.all([loadCategories(), loadStats()]);
                renderCategoryList();
                if (selectedCategoryId) {
                    await loadBrandsFor(selectedCategoryId);
                    renderBrandList();
                }
            } catch (e) {
                MV.toast(e.message, 'error');
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    async function openProductModal(id) {
        editingProductId = id;
        const list = selectedBrandId ? (productsByBrand[selectedBrandId] || []) : [];
        const p = id ? list.find(x => x.id === id) : null;

        $('#productModalTitle').textContent = p ? 'Edit Product' : 'New Product';
        $('#productSubmitLabel').textContent = p ? 'Save changes' : 'Create product';

        // Populate category select
        const catSel = $('#productCategory');
        catSel.innerHTML = categories.map(c =>
            `<option value="${c.id}">${MV.escHtml(c.name)}</option>`).join('');

        const targetCatId = p ? p.category_id : selectedCategoryId;
        catSel.value = targetCatId || (categories[0] && categories[0].id) || '';

        // Populate brand select for that category
        const cid = parseInt(catSel.value, 10);
        if (cid && !brandsByCat[cid]) await loadBrandsFor(cid);
        const brands = brandsByCat[cid] || [];
        const brSel = $('#productBrand');
        brSel.disabled = !brands.length;
        brSel.innerHTML = brands.length
            ? brands.map(b => `<option value="${b.id}">${MV.escHtml(b.name)}</option>`).join('')
            : '<option value="">No brands in this category — create one first</option>';
        brSel.value = p ? p.brand_id : (selectedBrandId || (brands[0] && brands[0].id) || '');

        $('#productName').value         = p ? p.name : '';
        $('#productDesc').value         = p ? (p.description || '') : '';
        $('#productCost').value         = p ? p.cost_price : '';
        $('#productSell').value         = p ? p.selling_price : '';
        $('#productStock').value        = p ? p.stock_quantity : '';
        $('#productLow').value          = p ? p.low_stock_threshold : 5;
        $('#productRefillable').checked = !!(p && p.is_refillable);
        $('#productPricePerMl').value   = p && p.price_per_ml != null ? p.price_per_ml : '';
        $('#ppmlGroup').classList.toggle('hide', !$('#productRefillable').checked);

        openModal('productModal');
        setTimeout(() => $('#productName').focus(), 80);
    }

    function renderProductList() {
        const root = $('#productList');
        if (!selectedBrandId) {
            root.innerHTML = emptyState('Select a brand', 'Pick a brand to see its products');
            return;
        }
        const list = productsByBrand[selectedBrandId] || [];
        if (!list.length) {
            root.innerHTML = emptyState('No products yet', 'Click + Add product');
            return;
        }
        root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
            '<th>Name</th>' +
            '<th class="num">Cost</th>' +
            '<th class="num">Price</th>' +
            '<th class="num">PKR/ml</th>' +
            '<th class="num">Stock</th>' +
            '<th>Status</th>' +
            '<th class="num">Actions</th>' +
            '</tr></thead><tbody>' +
            list.map(p => {
                const cost = Number(p.cost_price);
                const sell = Number(p.selling_price);
                const margin = sell > 0 ? ((sell - cost) / sell * 100).toFixed(1) + '%' : '—';
                const lowStock = !!p.low_stock;
                let statusBadge;
                if (p.stock_quantity <= 0) {
                    statusBadge = '<span class="badge badge-danger badge-dot">Out</span>';
                } else if (lowStock) {
                    statusBadge = '<span class="badge badge-danger badge-dot">Low</span>';
                } else {
                    statusBadge = '<span class="badge badge-success badge-dot">Healthy</span>';
                }
                const refBadge = p.is_refillable
                    ? '<span class="badge badge-info" style="margin-left:6px">Refillable</span>'
                    : '';
                return `
                    <tr>
                        <td>
                            <strong>${MV.escHtml(p.name)}</strong>${refBadge}
                            <div class="muted" style="font-size:11px">Margin: ${margin}</div>
                        </td>
                        <td class="num">${MV.fmtPKR(cost)}</td>
                        <td class="num text-amber">${MV.fmtPKR(sell)}</td>
                        <td class="num">${p.price_per_ml != null ? MV.fmtPKR(p.price_per_ml) : '—'}</td>
                        <td class="num"><strong>${p.stock_quantity}</strong> <span class="muted">/ ${p.low_stock_threshold}</span></td>
                        <td>${statusBadge}</td>
                        <td class="num">
                            <button class="btn btn-ghost btn-sm js-edit-prod" data-id="${p.id}">Edit</button>
                            <button class="btn btn-ghost btn-sm text-danger js-del-prod" data-id="${p.id}">Delete</button>
                        </td>
                    </tr>`;
            }).join('') + '</tbody></table></div>';

        $$('#productList .js-edit-prod').forEach(b =>
            b.addEventListener('click', () => openProductModal(parseInt(b.dataset.id, 10))));
        $$('#productList .js-del-prod').forEach(b =>
            b.addEventListener('click', () => deleteProduct(parseInt(b.dataset.id, 10))));
    }

    async function deleteProduct(id) {
        const list = productsByBrand[selectedBrandId] || [];
        const p = list.find(x => x.id === id);
        if (!p) return;
        if (!confirm(`Delete "${p.name}"?\n\nIt will be archived (soft-delete).`)) return;
        try {
            await MV.api('/api/products/' + id, { method: 'DELETE' });
            MV.toast('Product deleted', 'success');
            await loadProductsFor(selectedBrandId);
            renderProductList();
            await Promise.all([loadCategories(), loadStats()]);
            renderCategoryList();
            if (selectedCategoryId) {
                await loadBrandsFor(selectedCategoryId);
                renderBrandList();
            }
        } catch (e) {
            MV.toast(e.message, 'error');
        }
    }

    // =================================================================
    // Refill sizes tab
    // =================================================================
    function bindRefillSizeUI() {
        $('#addRefillSizeBtn').addEventListener('click', () => openRefillSizeModal(null));

        $('#refillSizeForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#refillSizeSubmit');
            const body = {
                label: $('#refillSizeLabel').value.trim(),
                ml_amount: parseFloat($('#refillSizeMl').value),
            };
            if (!body.label) return MV.toast('Label is required', 'error');
            if (!(body.ml_amount > 0)) return MV.toast('ml must be greater than 0', 'error');

            MV.setBusy(submit, true);
            try {
                if (editingRefillSizeId) {
                    await MV.api('/api/refill-sizes/' + editingRefillSizeId, { method: 'PUT', body });
                    MV.toast('Refill size updated', 'success');
                } else {
                    await MV.api('/api/refill-sizes', { method: 'POST', body });
                    MV.toast('Refill size created', 'success');
                }
                closeModal();
                await loadRefillSizes();
            } catch (e) {
                MV.toast(e.message, 'error');
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    function openRefillSizeModal(id) {
        editingRefillSizeId = id;
        const r = id ? refillSizes.find(x => x.id === id) : null;
        $('#refillSizeModalTitle').textContent = r ? 'Edit Refill Size' : 'New Refill Size';
        $('#refillSizeSubmitLabel').textContent = r ? 'Save changes' : 'Create';
        $('#refillSizeLabel').value = r ? r.label : '';
        $('#refillSizeMl').value = r ? r.ml_amount : '';
        openModal('refillSizeModal');
        setTimeout(() => $('#refillSizeLabel').focus(), 80);
    }

    async function loadRefillSizes() {
        const root = $('#refillSizesBody');
        try {
            const data = await MV.api('/api/refill-sizes?active=false');
            refillSizes = data.refill_sizes || [];
            if (!refillSizes.length) {
                root.innerHTML = emptyState('No refill sizes', 'Add one above');
                return;
            }
            root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
                '<th>Label</th><th class="num">Volume (ml)</th><th>Status</th><th class="num">Actions</th>' +
                '</tr></thead><tbody>' +
                refillSizes.map(r => `
                    <tr>
                        <td><strong>${MV.escHtml(r.label)}</strong></td>
                        <td class="num">${MV.fmtNum(r.ml_amount, 1)}</td>
                        <td>${r.is_active
                            ? '<span class="badge badge-success badge-dot">Active</span>'
                            : '<span class="badge">Disabled</span>'}</td>
                        <td class="num">
                            <button class="btn btn-ghost btn-sm js-edit-rs" data-id="${r.id}">Edit</button>
                            ${r.is_active
                                ? `<button class="btn btn-ghost btn-sm text-danger js-del-rs" data-id="${r.id}">Disable</button>`
                                : `<button class="btn btn-ghost btn-sm js-enable-rs" data-id="${r.id}">Re-enable</button>`}
                        </td>
                    </tr>
                `).join('') + '</tbody></table></div>';

            $$('#refillSizesBody .js-edit-rs').forEach(b =>
                b.addEventListener('click', () => openRefillSizeModal(parseInt(b.dataset.id, 10))));
            $$('#refillSizesBody .js-del-rs').forEach(b =>
                b.addEventListener('click', () => disableRefillSize(parseInt(b.dataset.id, 10))));
            $$('#refillSizesBody .js-enable-rs').forEach(b =>
                b.addEventListener('click', () => enableRefillSize(parseInt(b.dataset.id, 10))));
        } catch (e) {
            root.innerHTML = emptyState('Could not load refill sizes', e.message);
        }
    }

    async function disableRefillSize(id) {
        const r = refillSizes.find(x => x.id === id);
        if (!r) return;
        if (!confirm(`Disable refill size "${r.label}"? It will no longer appear in staff dropdowns.`)) return;
        try {
            await MV.api('/api/refill-sizes/' + id, { method: 'DELETE' });
            MV.toast('Refill size disabled', 'success');
            await loadRefillSizes();
        } catch (e) {
            MV.toast(e.message, 'error');
        }
    }
    async function enableRefillSize(id) {
        try {
            await MV.api('/api/refill-sizes/' + id, { method: 'PUT', body: { is_active: true } });
            MV.toast('Re-enabled', 'success');
            await loadRefillSizes();
        } catch (e) {
            MV.toast(e.message, 'error');
        }
    }

    // =================================================================
    // Purchases
    // =================================================================
    function bindPurchaseUI() {
        $('#purchaseCategory').addEventListener('change', async () => {
            const cid = parseInt($('#purchaseCategory').value, 10);
            const brSel = $('#purchaseBrand');
            const prSel = $('#purchaseProduct');
            prSel.innerHTML = '<option value="">— Select brand first —</option>';
            prSel.disabled = true;
            if (!cid) {
                brSel.innerHTML = '<option value="">— Select category first —</option>';
                brSel.disabled = true;
                return;
            }
            brSel.disabled = false;
            brSel.innerHTML = '<option value="">Loading…</option>';
            if (!brandsByCat[cid]) await loadBrandsFor(cid);
            const brands = brandsByCat[cid] || [];
            brSel.innerHTML = '<option value="">— Select brand —</option>' +
                brands.map(b => `<option value="${b.id}">${MV.escHtml(b.name)}</option>`).join('');
        });

        $('#purchaseBrand').addEventListener('change', async () => {
            const bid = parseInt($('#purchaseBrand').value, 10);
            const prSel = $('#purchaseProduct');
            if (!bid) {
                prSel.innerHTML = '<option value="">— Select brand first —</option>';
                prSel.disabled = true;
                return;
            }
            prSel.disabled = false;
            prSel.innerHTML = '<option value="">Loading…</option>';
            if (!productsByBrand[bid]) await loadProductsFor(bid);
            const list = productsByBrand[bid] || [];
            prSel.innerHTML = '<option value="">— Select product —</option>' +
                list.map(p =>
                    `<option value="${p.id}" data-cost="${p.cost_price}">${MV.escHtml(p.name)} (stock ${p.stock_quantity})</option>`).join('');
        });

        $('#purchaseProduct').addEventListener('change', e => {
            const opt = e.target.selectedOptions[0];
            if (opt && opt.dataset.cost) {
                $('#purchaseCost').placeholder = `Last cost PKR ${Number(opt.dataset.cost).toFixed(2)}`;
            }
        });

        $('#purchaseForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#purchaseSubmit');
            const body = {
                product_id: parseInt($('#purchaseProduct').value, 10),
                quantity_added: parseInt($('#purchaseQty').value, 10),
                cost_price_at_time: parseFloat($('#purchaseCost').value),
                supplier_name: $('#purchaseSupplier').value.trim(),
                update_cost_price: $('#purchaseUpdateCost').checked,
            };
            if (!body.product_id) return MV.toast('Select a product', 'error');
            if (!(body.quantity_added >= 1)) return MV.toast('Quantity must be at least 1', 'error');
            if (!(body.cost_price_at_time >= 0)) return MV.toast('Enter a valid cost price', 'error');

            MV.setBusy(submit, true);
            try {
                await MV.api('/api/purchases', { method: 'POST', body });
                MV.toast('Restock recorded', 'success');
                $('#purchaseQty').value = '';
                $('#purchaseCost').value = '';
                $('#purchaseSupplier').value = '';
                $('#purchaseUpdateCost').checked = false;
                // Refresh product cache for that brand and re-trigger product dropdown
                const bid = parseInt($('#purchaseBrand').value, 10);
                if (bid) {
                    await loadProductsFor(bid);
                    $('#purchaseBrand').dispatchEvent(new Event('change'));
                }
                await Promise.all([loadPurchases(), loadStats()]);
            } catch (e) {
                MV.toast(e.message, 'error');
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    async function refreshPurchasesTab() {
        // Populate category select
        const sel = $('#purchaseCategory');
        sel.innerHTML = '<option value="">— Select category —</option>' +
            categories.map(c => `<option value="${c.id}">${MV.escHtml(c.name)}</option>`).join('');
        await loadPurchases();
    }

    async function loadPurchases() {
        const root = $('#purchasesBody');
        try {
            const data = await MV.api('/api/purchases');
            const list = data.purchases || [];
            if (!list.length) {
                root.innerHTML = emptyState('No restocks yet', 'Recorded purchases will appear here');
                return;
            }
            root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
                '<th>Date</th><th>Product</th><th>Supplier</th>' +
                '<th class="num">Qty</th><th class="num">Unit Cost</th><th class="num">Total</th>' +
                '<th class="num">Actions</th>' +
                '</tr></thead><tbody>' +
                list.map(p => `
                    <tr>
                        <td class="muted">${MV.fmtDate(p.purchased_at)}</td>
                        <td>
                            <strong>${MV.escHtml(p.product_name)}</strong>
                            <div class="muted" style="font-size:11px">${MV.escHtml(p.brand_name)} · ${MV.escHtml(p.category_name)}</div>
                        </td>
                        <td>${MV.escHtml(p.supplier_name || '—')}</td>
                        <td class="num">${p.quantity_added}</td>
                        <td class="num">${MV.fmtPKR(p.cost_price_at_time)}</td>
                        <td class="num text-amber">${MV.fmtPKR(p.total_cost)}</td>
                        <td class="num">
                            <button class="btn btn-ghost btn-sm text-danger js-del-purchase"
                                    data-id="${p.id}"
                                    data-summary="${MV.escHtml(`${p.quantity_added} x ${p.brand_name} ${p.product_name}`)}">
                                Delete
                            </button>
                        </td>
                    </tr>
                `).join('') + '</tbody></table></div>';

            $$('#purchasesBody .js-del-purchase').forEach(b =>
                b.addEventListener('click', () =>
                    deletePurchase(parseInt(b.dataset.id, 10), b.dataset.summary)));
        } catch (e) {
            root.innerHTML = emptyState('Could not load purchases', e.message);
        }
    }

    async function deletePurchase(id, summary) {
        const msg = `Delete this purchase record?\n\n${summary}\n\n` +
            `Stock will NOT be reversed — only the history entry is removed.\n` +
            `This action is recorded in the audit log and cannot be undone.`;
        if (!confirm(msg)) return;
        try {
            await MV.api('/api/purchases/' + id, { method: 'DELETE' });
            MV.toast('Purchase record deleted (stock unchanged)', 'success');
            await loadPurchases();
        } catch (e) {
            MV.toast(e.message, 'error');
        }
    }

    // =================================================================
    // Staff (unchanged feature)
    // =================================================================
    function bindStaffUI() {
        $('#staffForm').addEventListener('submit', async e => {
            e.preventDefault();
            const submit = $('#staffSubmit');
            const body = {
                name: $('#staffName').value.trim(),
                email: $('#staffEmail').value.trim().toLowerCase(),
                password: $('#staffPassword').value,
            };
            if (!body.name || !body.email || !body.password)
                return MV.toast('Fill all fields', 'error');
            if (body.password.length < 6)
                return MV.toast('Password must be at least 6 characters', 'error');

            MV.setBusy(submit, true);
            try {
                await MV.api('/api/staff', { method: 'POST', body });
                MV.toast(`Staff "${body.name}" created`, 'success');
                e.target.reset();
                await Promise.all([loadStaff(), loadStats()]);
            } catch (e) {
                MV.toast(e.message, 'error');
            } finally {
                MV.setBusy(submit, false);
            }
        });
    }

    async function loadStaff() {
        const root = $('#staffBody');
        try {
            const data = await MV.api('/api/staff');
            const staff = data.staff || [];
            if (!staff.length) {
                root.innerHTML = emptyState('No staff yet', 'Create a staff account using the form above');
                return;
            }
            root.innerHTML = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
                '<th>Member</th><th>Email</th>' +
                '<th class="num">Sales</th><th class="num">Sale Revenue</th>' +
                '<th class="num">Refills</th><th class="num">Refill Revenue</th>' +
                '<th>Status</th><th class="num">Actions</th>' +
                '</tr></thead><tbody>' +
                staff.map(s => `
                    <tr>
                        <td>
                            <div class="flex items-center gap-3">
                                <span class="avatar avatar-sm ${MV.avatarClass(s.name)}">${MV.initials(s.name)}</span>
                                <strong>${MV.escHtml(s.name)}</strong>
                            </div>
                        </td>
                        <td class="muted">${MV.escHtml(s.email)}</td>
                        <td class="num">${MV.fmtNum(s.sales_count_today)}</td>
                        <td class="num">${MV.fmtPKR(s.sales_total_today)}</td>
                        <td class="num">${MV.fmtNum(s.refills_count_today)}</td>
                        <td class="num">${MV.fmtPKR(s.refills_total_today)}</td>
                        <td>${s.is_active
                            ? '<span class="badge badge-success badge-dot">Active</span>'
                            : '<span class="badge">Deactivated</span>'}</td>
                        <td class="num">
                            ${s.is_active
                                ? `<button class="btn btn-ghost btn-sm text-danger js-deact" data-id="${s.id}">Deactivate</button>`
                                : '<span class="muted">—</span>'}
                        </td>
                    </tr>
                `).join('') + '</tbody></table></div>';

            $$('#staffBody .js-deact').forEach(b =>
                b.addEventListener('click', () => deactivateStaff(parseInt(b.dataset.id, 10))));
        } catch (e) {
            root.innerHTML = emptyState('Could not load staff', e.message);
        }
    }

    async function deactivateStaff(id) {
        if (!confirm('Deactivate this staff member? They will lose access immediately.')) return;
        try {
            await MV.api(`/api/staff/${id}/deactivate`, { method: 'PUT' });
            MV.toast('Staff deactivated', 'success');
            await loadStaff();
            await loadStats();
        } catch (e) {
            MV.toast(e.message, 'error');
        }
    }

    // =================================================================
    // Audit
    // =================================================================
    function bindAuditUI() {
        $('#auditPrev').addEventListener('click', () => {
            if (auditPage > 1) loadAudit(auditPage - 1);
        });
        $('#auditNext').addEventListener('click', () => {
            if (auditPage < auditTotalPages) loadAudit(auditPage + 1);
        });
    }

    async function loadAudit(page) {
        auditPage = page;
        const root = $('#auditBody');
        root.innerHTML = '<div class="audit-list">' +
            Array.from({ length: 6 }).map(() => `
                <div class="audit-entry">
                    <div class="skeleton" style="width:32px;height:32px;border-radius:50%"></div>
                    <div>
                        <div class="skeleton" style="width:40%;height:13px;margin-bottom:6px"></div>
                        <div class="skeleton" style="width:80%;height:12px"></div>
                    </div>
                    <div class="skeleton" style="width:90px;height:12px"></div>
                </div>
            `).join('') + '</div>';

        try {
            const data = await MV.api('/api/audit?page=' + page);
            const entries = data.entries || [];
            auditTotalPages = data.total_pages || 1;
            $('#auditPageInfo').textContent =
                `Page ${data.page} of ${data.total_pages} · ${MV.fmtNum(data.total)} entries`;
            $('#auditPrev').disabled = data.page <= 1;
            $('#auditNext').disabled = data.page >= data.total_pages;

            if (!entries.length) {
                root.innerHTML = emptyState('No activity', 'Actions appear here as they happen');
                return;
            }
            root.innerHTML = '<div class="audit-list">' + entries.map(a => `
                <div class="audit-entry">
                    <span class="avatar avatar-sm ${MV.avatarClass(a.user_name)}">${MV.initials(a.user_name)}</span>
                    <div class="audit-body">
                        <div class="audit-head">
                            <span class="audit-user">${MV.escHtml(a.user_name)}</span>
                            ${badgeForAction(a.action)}
                            <span class="badge">${MV.escHtml(a.role || '')}</span>
                        </div>
                        <div class="audit-details">${MV.escHtml(a.details || '')}</div>
                    </div>
                    <div class="audit-meta">
                        ${MV.fmtDate(a.timestamp)}<br>
                        <span class="muted">IP ${MV.escHtml(a.ip_address || '—')}</span>
                    </div>
                </div>
            `).join('') + '</div>';
        } catch (e) {
            root.innerHTML = emptyState('Could not load audit log', e.message);
        }
    }

    function badgeForAction(a) {
        const map = {
            LOGIN_SUCCESS:        ['Login',         'badge-success'],
            LOGIN_FAILED:         ['Login Failed',  'badge-danger'],
            LOGOUT:               ['Logout',        'badge'],
            SALE_RECORD:          ['Sale',          'badge-amber'],
            REFILL_RECORD:        ['Refill',        'badge-info'],
            STOCK_PURCHASE:       ['Restock',       'badge-info'],
            PURCHASE_DELETE:      ['Restock −',     'badge-danger'],
            CATEGORY_CREATE:      ['Cat +',         'badge-success'],
            CATEGORY_UPDATE:      ['Cat Edit',      'badge-amber'],
            CATEGORY_DELETE:      ['Cat −',         'badge-danger'],
            BRAND_CREATE:         ['Brand +',       'badge-success'],
            BRAND_UPDATE:         ['Brand Edit',    'badge-amber'],
            BRAND_DELETE:         ['Brand −',       'badge-danger'],
            PRODUCT_CREATE:       ['Product +',     'badge-success'],
            PRODUCT_UPDATE:       ['Product Edit',  'badge-amber'],
            PRODUCT_DELETE:       ['Product −',     'badge-danger'],
            STAFF_CREATE:         ['Staff +',       'badge-success'],
            STAFF_DEACTIVATE:     ['Staff Off',     'badge-danger'],
            REFILL_SIZE_CREATE:   ['Size +',        'badge-success'],
            REFILL_SIZE_UPDATE:   ['Size Edit',     'badge-amber'],
            REFILL_SIZE_DELETE:   ['Size Off',      'badge-danger'],
            TEST_DATA_RESET:      ['RESET',         'badge-danger'],
        };
        const [label, cls] = map[a] || [a, 'badge'];
        return `<span class="badge ${cls}">${MV.escHtml(label)}</span>`;
    }

    // =================================================================
    // Reset (Settings tab)
    // =================================================================
    function bindResetUI() {
        $('#openResetBtn').addEventListener('click', () => {
            $('#resetConfirm').value = '';
            $('#resetSubmit').disabled = true;
            openModal('resetModal');
            setTimeout(() => $('#resetConfirm').focus(), 80);
        });

        $('#resetConfirm').addEventListener('input', e => {
            $('#resetSubmit').disabled = e.target.value.trim() !== 'RESET';
        });

        $('#resetSubmit').addEventListener('click', async () => {
            if ($('#resetConfirm').value.trim() !== 'RESET') return;
            const btn = $('#resetSubmit');
            MV.setBusy(btn, true);
            try {
                const r = await MV.api('/api/admin/reset-test-data', {
                    method: 'DELETE',
                    body: { confirm: 'RESET' },
                });
                closeModal();
                const s = r.stats;
                MV.toast(
                    `Reset complete · wiped ${s.categories_deleted} categories, ` +
                    `${s.brands_deleted} brands, ${s.products_deleted} products, ` +
                    `${s.sales_deleted} sales, ${s.refills_deleted} refills, ` +
                    `${s.purchases_deleted} purchases · re-seeded ${s.refill_sizes_seeded} refill sizes`,
                    'success'
                );
                // Clear local caches so stale data doesn't render
                categories = [];
                brandsByCat = {};
                productsByBrand = {};
                refillSizes = [];
                selectedCategoryId = null;
                selectedBrandId = null;
                $('#addBrandBtn').disabled = true;
                $('#addProductBtn').disabled = true;
                await Promise.all([
                    loadStats(),
                    loadRecentTransactions(),
                    refreshProductsTab(),
                ]);
            } catch (e) {
                MV.toast(e.message, 'error');
            } finally {
                MV.setBusy(btn, false);
            }
        });
    }

    // =================================================================
    // Modal helpers
    // =================================================================
    function bindModals() {
        $$('.modal-backdrop [data-close-modal]').forEach(b =>
            b.addEventListener('click', () => closeModal()));
        $$('.modal-backdrop').forEach(bd =>
            bd.addEventListener('click', e => { if (e.target === bd) closeModal(); }));
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeModal();
        });
    }
    function openModal(id) { $('#' + id).classList.add('active'); }
    function closeModal()  { $$('.modal-backdrop').forEach(m => m.classList.remove('active')); }

    // =================================================================
    // Empty state
    // =================================================================
    function emptyState(title, sub) {
        return `<div class="empty-state">
            <div class="empty-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3"/>
                    <line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>
                </svg>
            </div>
            <div class="empty-title">${MV.escHtml(title)}</div>
            <div class="empty-sub">${MV.escHtml(sub)}</div>
        </div>`;
    }
})();
