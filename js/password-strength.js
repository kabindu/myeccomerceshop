/* ============================================================
   Shared helpers for the two standalone auth forms in this project
   (account.html for customers, seller/login.html for sellers) -
   both had byte-identical copies of request() and the password
   strength meter; this is the one copy.
   ============================================================ */
async function request(url, options = {}){
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if(!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

/* Guidance only - the 6-char minimum on the input is what's actually
   enforced server-side. */
function passwordStrength(password){
  if(!password) return { level: 0, label: '' };
  let score = 0;
  if(password.length >= 6) score++;
  if(password.length >= 10) score++;
  if(/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if(/\d/.test(password)) score++;
  if(/[^A-Za-z0-9]/.test(password)) score++;
  // A password using only digits or only letters (e.g. "123456") is
  // trivially guessable no matter how long it is - never rate those above Weak.
  if(/^\d+$/.test(password) || /^[A-Za-z]+$/.test(password)) score = Math.min(score, 1);
  if(score <= 1) return { level: 1, label: 'Weak' };
  if(score === 2) return { level: 2, label: 'Medium' };
  if(score <= 4) return { level: 3, label: 'Strong' };
  return { level: 4, label: 'Very strong' };
}

function wirePasswordStrength(inputId, meterId){
  const input = document.getElementById(inputId);
  const meter = document.getElementById(meterId);
  if(!input || !meter) return;
  input.addEventListener('input', () => {
    const { level, label } = passwordStrength(input.value);
    meter.hidden = !input.value;
    meter.dataset.level = level;
    meter.querySelector('.pw-strength-label').textContent = label;
  });
}
