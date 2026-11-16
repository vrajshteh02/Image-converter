/* Tools sidebar: mobile drawer + search filter (shared by home and tool pages) */
(function () {
    var sidebar = document.getElementById('toolsSidebar');
    var toggle = document.getElementById('sidebarToggle');
    var closeBtn = document.getElementById('sidebarClose');
    var backdrop = document.getElementById('sidebarBackdrop');
    var search = document.getElementById('toolSearch');
    if (!sidebar || !toggle) return;

    function setOpen(open) {
        sidebar.classList.toggle('is-open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        backdrop.hidden = !open;
        document.body.classList.toggle('sidebar-locked', open);
        if (open) search.focus();
    }
    // Desktop: hide/show the sidebar column (remembered across pages; applied early by the <head> script)
    var desktop = window.matchMedia('(min-width: 1101px)');
    var root = document.documentElement;
    function setCollapsed(collapsed) {
        root.classList.toggle('sidebar-collapsed', collapsed);
        try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) { /* storage blocked */ }
        syncExpanded();
    }
    function syncExpanded() {
        var expanded = desktop.matches ? !root.classList.contains('sidebar-collapsed') : sidebar.classList.contains('is-open');
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
    if (desktop.addEventListener) desktop.addEventListener('change', syncExpanded);
    syncExpanded();

    toggle.addEventListener('click', function () {
        if (desktop.matches) { setCollapsed(false); search.focus(); }
        else setOpen(true);
    });
    closeBtn.addEventListener('click', function () {
        if (desktop.matches) setCollapsed(true);
        else setOpen(false);
        toggle.focus();
    });
    backdrop.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && sidebar.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
    });
    sidebar.querySelectorAll('.sidebar-link').forEach(function (a) {
        a.addEventListener('click', function () { if (!desktop.matches) setOpen(false); });
    });

    // Filter sidebar links and tool cards together
    search.addEventListener('input', function () {
        var q = search.value.trim().toLowerCase();
        var anyLink = false, anyCard = false;
        sidebar.querySelectorAll('.sidebar-group').forEach(function (g) {
            var shown = 0;
            g.querySelectorAll('.sidebar-link').forEach(function (a) {
                var hit = !q || a.textContent.toLowerCase().indexOf(q) !== -1;
                a.hidden = !hit;
                if (hit) shown++;
            });
            g.hidden = shown === 0;
            if (shown) anyLink = true;
        });
        document.querySelectorAll('.home-section').forEach(function (s) {
            var shown = 0;
            s.querySelectorAll('.tool-hub-card').forEach(function (c) {
                var hit = !q || c.textContent.toLowerCase().indexOf(q) !== -1;
                c.hidden = !hit;
                if (hit) shown++;
            });
            s.hidden = shown === 0;
            if (shown) anyCard = true;
        });
        document.getElementById('sidebarEmpty').hidden = anyLink;
        var cardsEmpty = document.getElementById('cardsEmpty');
        if (cardsEmpty) cardsEmpty.hidden = anyCard;
    });
})();

