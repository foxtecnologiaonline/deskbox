// Pub/sub minúsculo pra disparar toasts de qualquer componente sem precisar
// passar callbacks por várias camadas de props. Um único <ToastHost/> (montado
// uma vez em App.tsx) se inscreve e renderiza a mensagem mais recente.
type ToastListener = (message: string) => void

let listener: ToastListener | null = null

export function showToast(message: string): void {
  listener?.(message)
}

export function setToastListener(fn: ToastListener | null): void {
  listener = fn
}
