// UIT CLI & Studio — Interactive Scripts
// Trường Đại học Công nghệ Thông tin - ĐHQG-HCM

document.addEventListener('DOMContentLoaded', () => {
  // --- Theme Toggle ---
  const themeToggle = document.getElementById('theme-toggle');
  const themeText = document.getElementById('theme-label');
  const savedTheme = localStorage.getItem('uit-theme') || 
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeButton(savedTheme);

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('uit-theme', next);
      updateThemeButton(next);
    });
  }

  function updateThemeButton(theme) {
    if (!themeText) return;
    themeText.textContent = theme === 'light' ? '🌙 Dark' : '☀️ Light';
  }

  // --- Copy Functionality ---
  window.copyCommand = function(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.innerHTML;
      btn.classList.add('copied');
      btn.innerHTML = `✓ Đã sao chép!`;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = orig;
      }, 2000);
    }).catch(err => {
      console.error('Copy error:', err);
    });
  };

  // --- Quick Install Command Tabs ---
  const installCommands = {
    npm: 'npm install -g uit-cli',
    curl: 'curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh',
    studio: 'curl -fsSL https://raw.githubusercontent.com/RyanNg1403/uit-cli/main/scripts/install.sh | sh -s -- --studio',
    windows: 'npm install -g uit-cli uit-studio'
  };

  const installTabs = document.querySelectorAll('.install-tab-btn');
  const installCode = document.getElementById('install-code');
  const installBtn = document.getElementById('btn-copy-install');

  installTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      installTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const platform = tab.getAttribute('data-platform');
      const cmd = installCommands[platform] || installCommands.npm;
      if (installCode) installCode.textContent = cmd;
      if (installBtn) installBtn.setAttribute('onclick', `copyCommand('${cmd}', this)`);
    });
  });

  // --- Showcase View Switcher ---
  const showcaseBtns = document.querySelectorAll('.showcase-switcher-btn');
  const stageViews = document.querySelectorAll('.stage-view');

  showcaseBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      showcaseBtns.forEach(b => b.classList.remove('active'));
      stageViews.forEach(v => v.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.classList.add('active');
    });
  });

  // --- Real UIT Course Interactive Terminal Simulation ---
  const termCmdBtns = document.querySelectorAll('.term-cmd-btn');
  const termOutputs = document.querySelectorAll('.term-output-block');
  const termCmdActiveText = document.getElementById('term-active-cmd');

  termCmdBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      termCmdBtns.forEach(b => b.classList.remove('active'));
      termOutputs.forEach(o => o.classList.remove('active'));

      btn.classList.add('active');
      const cmdName = btn.getAttribute('data-cmd');
      const targetBlock = document.getElementById(`term-block-${cmdName}`);
      if (targetBlock) targetBlock.classList.add('active');
      if (termCmdActiveText) termCmdActiveText.textContent = btn.getAttribute('data-fullcmd');
    });
  });

  // --- FAQ Accordions ---
  const faqBoxes = document.querySelectorAll('.faq-box');
  faqBoxes.forEach(box => {
    const trigger = box.querySelector('.faq-trigger');
    if (trigger) {
      trigger.addEventListener('click', () => {
        const isActive = box.classList.contains('active');
        faqBoxes.forEach(b => b.classList.remove('active'));
        if (!isActive) {
          box.classList.add('active');
        }
      });
    }
  });
});
