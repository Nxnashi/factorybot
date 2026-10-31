// iPhone: клавиатура сама не закрывается. Закрываем: тап мимо поля, прокрутка пальцем, кнопка "Готово"
(function () {
  const isField = el => el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]');
  const noKeyboardTypes = ['checkbox', 'radio', 'button', 'submit', 'date', 'file'];
  const needsKeyboard = el => {
    const f = isField(el);
    if (!f) return false;
    if (f.tagName === 'INPUT' && noKeyboardTypes.includes(f.type)) return false;
    return f.tagName !== 'SELECT';
  };

  const style = document.createElement('style');
  style.textContent = `
    .kbd-done { position: fixed; right: 10px; z-index: 9999; display: none; padding: 9px 16px;
      border: none; border-radius: 18px; background: #1c1c1e; color: #fff; font-size: 14px; font-weight: 700;
      box-shadow: 0 2px 10px rgba(0,0,0,.3); }
    .kbd-done.show { display: block; }`;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'kbd-done';
  btn.textContent = 'Готово ✓';
  document.body.appendChild(btn);

  const blurActive = () => { const a = document.activeElement; if (needsKeyboard(a)) a.blur(); };

  // Кнопка "Готово" висит над клавиатурой (по visualViewport)
  function place() {
    const vv = window.visualViewport;
    const bottom = vv ? Math.max(0, window.innerHeight - (vv.height + vv.offsetTop)) : 0;
    btn.style.bottom = (bottom + 10) + 'px';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', place);
    window.visualViewport.addEventListener('scroll', place);
  }
  btn.addEventListener('touchstart', e => e.preventDefault(), { passive: false }); // не терять фокус до blur
  btn.addEventListener('click', blurActive);

  document.addEventListener('focusin', e => { if (needsKeyboard(e.target)) { place(); btn.classList.add('show'); } });
  document.addEventListener('focusout', () => setTimeout(() => { if (!needsKeyboard(document.activeElement)) btn.classList.remove('show'); }, 50));

  // Тап по любому месту вне поля — клавиатура уходит
  document.addEventListener('click', e => {
    if (e.target === btn) return;
    if (!isField(e.target)) blurActive();
  }, true);

  // Листаешь пальцем — клавиатура уходит
  let startY = null, startedInField = false;
  document.addEventListener('touchstart', e => { startY = e.touches[0].clientY; startedInField = !!isField(e.target); }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (startY === null || startedInField) return;
    if (Math.abs(e.touches[0].clientY - startY) > 12) { blurActive(); startY = null; }
  }, { passive: true });

  // Enter тоже закрывает
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && needsKeyboard(e.target) && e.target.tagName === 'INPUT') e.target.blur(); });
})();
