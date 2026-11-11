/* =========================================================
   PADANIA TUNING CHECK-IN — CHRISTMAS EDITION 🎄
   Tema natalizio dell'app e dello Schermo live (insieme a natale.css).
   Per spegnerlo metti  attivo: false.
   Si spegne comunque da solo dalla data "fino" (dopo l'Epifania).
   Anteprima forzata: aggiungi ?natale=1 (o ?natale=0) all'indirizzo.
   ========================================================= */
(function () {
    var NATALE = { attivo: true, fino: '2027-01-07' };

    var q = new URLSearchParams(location.search).get('natale');
    var acceso = q === '1' || (q !== '0' && NATALE.attivo && Date.now() < new Date(NATALE.fino + 'T00:00:00+01:00').getTime());
    if (!acceso) return;
    document.documentElement.classList.add('natale');   // subito, così non si vede il cambio di colori

    var CAPPELLO =
        '<svg class="xmas-hat" viewBox="0 0 34 30" aria-hidden="true">' +
            '<path d="M4 23 C6 9 16 2 29 6 C24 8 23 14 25 23 Z" fill="#e11d2e"/>' +
            '<path d="M4 23 C6 9 16 2 29 6 C20 6 11 11 9 23 Z" fill="#ff4a57" opacity=".55"/>' +
            '<rect x="1" y="20" width="27" height="8" rx="4" fill="#f6fbff"/>' +
            '<circle cx="30" cy="7" r="4" fill="#f6fbff"/>' +
        '</svg>';
    var CHIAVE = 'ptNeve';
    var calmo = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function luminarie(dove, prima) {
        var luci = document.createElement('div');
        luci.className = 'xmas-lights';
        luci.setAttribute('aria-hidden', 'true');
        dove.insertBefore(luci, prima || null);
        var ultima = 0;
        function riempi() {
            var w = luci.clientWidth || window.innerWidth;
            if (Math.abs(w - ultima) < 28) return;
            ultima = w;
            var n = Math.ceil(w / 56), html = '';
            for (var i = 0; i < n; i++) html += '<i style="left:' + (i * 56 + 28) + 'px"></i>';
            luci.innerHTML = html;
        }
        riempi();
        window.addEventListener('resize', riempi);
    }

    function cappelloSu(img) {              // cappello sopra un logo grande (login, avvio)
        if (!img || !img.parentNode) return;
        var wrap = document.createElement('span');
        wrap.className = 'xmas-wrap';
        img.parentNode.insertBefore(wrap, img);
        wrap.appendChild(img);
        wrap.insertAdjacentHTML('beforeend', CAPPELLO);
    }

    /* ---------- NEVE ---------- */
    var canvas, ctx, fiocchi = [], raf = 0, W = 0, H = 0, vento = 0, massimo = 60, nevica = false;
    function nuovo(ovunque) {
        var z = Math.random();
        return { x: Math.random() * W, y: ovunque ? Math.random() * H : -10, r: .8 + z * 2.2, v: .3 + z * 1.05, a: .2 + z * .5, f: Math.random() * 6.28, s: .008 + Math.random() * .02 };
    }
    function misura() {
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        W = window.innerWidth; H = window.innerHeight;
        canvas.width = W * dpr; canvas.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        var quanti = Math.max(22, Math.min(massimo, Math.round(W / 12)));
        while (fiocchi.length < quanti) fiocchi.push(nuovo(true));
        fiocchi.length = quanti;
    }
    function disegna() {
        ctx.clearRect(0, 0, W, H);
        vento += .002;
        var spinta = Math.sin(vento) * .35;
        ctx.fillStyle = '#fff';
        for (var i = 0; i < fiocchi.length; i++) {
            var p = fiocchi[i];
            p.f += p.s; p.y += p.v; p.x += Math.sin(p.f) * .5 + spinta * p.v;
            if (p.y > H + 6) { fiocchi[i] = nuovo(false); continue; }
            if (p.x < -6) p.x = W + 6; else if (p.x > W + 6) p.x = -6;
            ctx.globalAlpha = p.a;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
        }
        raf = requestAnimationFrame(disegna);
    }
    function neve(on) {
        nevica = on;
        cancelAnimationFrame(raf);
        if (!on) { if (canvas) canvas.style.display = 'none'; return; }
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'xmas-snow';
            canvas.setAttribute('aria-hidden', 'true');
            document.body.appendChild(canvas);
            ctx = canvas.getContext('2d');
            window.addEventListener('resize', misura);
        }
        canvas.style.display = '';
        misura();
        raf = requestAnimationFrame(disegna);
    }
    document.addEventListener('visibilitychange', function () {
        cancelAnimationFrame(raf);
        if (nevica && !document.hidden) raf = requestAnimationFrame(disegna);
    });
    function neveSalvata() {
        var v = null;
        try { v = localStorage.getItem(CHIAVE); } catch (e) {}
        return v === null ? !calmo : v === '1';
    }

    /* ---------- MONTAGGIO ---------- */
    function monta() {
        var schermo = !!document.querySelector('.wrap .gauge-card');

        if (schermo) {
            /* ===== Schermo live ===== */
            document.body.classList.add('xm-schermo');
            massimo = 130;
            luminarie(document.body, document.querySelector('.wrap'));
            var b = document.querySelector('.wrap .brand');
            if (b) b.insertAdjacentHTML('beforeend', CAPPELLO);
            neve(!calmo);
            return;
        }

        /* ===== App check-in ===== */
        var app = document.querySelector('.app');
        if (app) luminarie(app, app.firstChild);

        var brand = document.querySelector('.topbar .brand');
        if (brand) brand.insertAdjacentHTML('beforeend', CAPPELLO);
        cappelloSu(document.querySelector('.auth-logo'));
        cappelloSu(document.querySelector('#splash img'));

        var art = document.querySelector('.welcome-art');
        if (art) art.textContent = '🎄';

        var ver = document.querySelector('.version');
        if (ver) ver.insertAdjacentHTML('afterbegin', '🎄 Christmas Edition · ');

        // interruttore "Neve" in Strumenti → Impostazioni
        var big = document.getElementById('bigToggle');
        var menu = big && big.closest('.menu');
        var on = neveSalvata();
        if (menu) {
            menu.insertAdjacentHTML('afterbegin',
                '<div class="menu-item static"><span class="mi-ico">❄️</span><span><b>Neve</b><small>Effetto natalizio · spegnila se ti distrae</small></span>' +
                '<label class="switch"><input type="checkbox" id="xmasSnowToggle"' + (on ? ' checked' : '') + '><i></i></label></div>');
            document.getElementById('xmasSnowToggle').addEventListener('change', function () {
                try { localStorage.setItem(CHIAVE, this.checked ? '1' : '0'); } catch (e) {}
                neve(this.checked);
            });
        }
        neve(on);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', monta);
    else monta();
})();
