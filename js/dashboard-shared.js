/* ============================================================
   DASHBOARD SHARED HELPERS — generic toast/confirm/file-preview
   utilities used by both admin/js/admin.js and seller/js/seller.js.
   Pulled out here because the two dashboards had byte-identical
   copies of all four functions; this is the one copy.
   ============================================================ */
function ensureNotifyStyles() {
  if (document.getElementById('notifyStyles')) return;
  const style = document.createElement('style');
  style.id = 'notifyStyles';
  style.textContent = `#toastStack{position:fixed;top:20px;right:20px;z-index:300;display:flex;flex-direction:column;gap:8px;pointer-events:none;}.toast{pointer-events:auto;min-width:220px;max-width:340px;padding:12px 16px;border-radius:8px;font-size:13px;font-weight:600;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;transform:translateX(16px);transition:opacity .2s ease,transform .2s ease;}.toast.show{opacity:1;transform:translateX(0);}.toast.success{background:#16845b;}.toast.error{background:#c24135;}.toast.info{background:#142333;}.confirm-backdrop{position:fixed;inset:0;background:rgba(19,25,33,.55);display:flex;align-items:center;justify-content:center;z-index:310;}.confirm-box{background:#fff;border-radius:10px;padding:22px 24px;max-width:340px;box-shadow:0 24px 60px rgba(0,0,0,.25);}.confirm-box p{margin:0 0 18px;font-size:14px;color:#17212b;line-height:1.5;}.confirm-actions{display:flex;justify-content:flex-end;gap:8px;}`;
  document.head.appendChild(style);
}

function showToast(message, type = 'success') {
  ensureNotifyStyles();
  let stack = document.getElementById('toastStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toastStack';
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

function confirmAction(message) {
  ensureNotifyStyles();
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `<div class="confirm-box"><p>${message}</p><div class="confirm-actions"><button type="button" class="secondary-button" data-confirm="cancel">Cancel</button><button type="button" class="primary-button" data-confirm="ok">Confirm</button></div></div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) { backdrop.remove(); resolve(false); return; }
      const action = event.target.closest('[data-confirm]');
      if (!action) return;
      backdrop.remove();
      resolve(action.dataset.confirm === 'ok');
    });
  });
}

function readImage(input, preview) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener('load', () => { preview.src = reader.result; preview.classList.add('visible'); });
  reader.readAsDataURL(file);
}
