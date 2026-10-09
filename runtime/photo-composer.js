const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export function photoDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('写真を読み取れませんでした。');
  const ratio = Math.min(1, 1280 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export async function preparePhoto(file) {
  if (!file || file.size === 0 || file.size > MAX_FILE_BYTES) throw new Error('20MB以下の写真を1枚選んでください。');
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type)) throw new Error('JPEG・PNG・WebPの写真を選んでください。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('この写真形式は読み取れません。JPEG・PNGで保存して選び直してください。'));
      image.src = url;
    });
    const dimensions = photoDimensions(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width; canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('写真を準備できませんでした。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob;
    for (const quality of [0.85, 0.7, 0.55]) {
      blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_IMAGE_BYTES) break;
    }
    canvas.width = canvas.height = 0;
    if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('写真が大きすぎます。小さくして選び直してください。');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('写真を読み込めませんでした。'));
      reader.readAsDataURL(blob);
    });
    return { data_url: dataUrl };
  } finally { URL.revokeObjectURL(url); }
}

export function createPhotoComposer({ onChange, onPick, onError }) {
  const pick = document.getElementById('photo-pick');
  const input = document.getElementById('photo-file');
  const preview = document.getElementById('photo-preview');
  const thumbnail = document.getElementById('photo-thumbnail');
  const remove = document.getElementById('photo-remove');
  const message = document.getElementById('photo-message');
  let image = null, generation = 0, preparing = false, disabled = false;
  const render = () => {
    preview.hidden = !image && !preparing;
    thumbnail.hidden = !image;
    if (image) thumbnail.src = image.data_url; else thumbnail.removeAttribute('src');
    message.textContent = preparing ? '写真を準備しています…' : '写真1枚 · 送信した返答で参照します';
    pick.disabled = disabled || preparing;
    remove.disabled = disabled;
    onChange?.();
  };
  const clear = () => { generation++; preparing = false; image = null; input.value = ''; render(); };
  pick.onclick = () => input.click();
  remove.onclick = clear;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file || disabled) return;
    const current = ++generation;
    image = null; preparing = true; render();
    try {
      await onPick?.();
      const prepared = await preparePhoto(file);
      if (current !== generation) return;
      image = prepared;
    } catch (error) { if (current === generation) onError?.(error.message); }
    finally { if (current === generation) { preparing = false; input.value = ''; render(); } }
  };
  return {
    get image() { return image; },
    get preparing() { return preparing; },
    clear,
    setDisabled(value) { disabled = value; pick.disabled = disabled || preparing; remove.disabled = disabled; }
  };
}
