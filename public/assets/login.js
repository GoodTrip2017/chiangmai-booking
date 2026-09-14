document.getElementById('loginForm').addEventListener('submit', async function (event) {
  event.preventDefault();
  const button = document.getElementById('loginButton');
  const password = document.getElementById('password');
  const error = document.getElementById('error');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '登入中…';
  error.textContent = '';
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    password.value = '';
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登入失敗，請稍後再試。');
    location.replace('/admin');
  } catch (err) {
    password.value = '';
    error.textContent = err.message || '無法連線，請稍後再試。';
    button.disabled = false;
    button.textContent = '登入';
  }
});
