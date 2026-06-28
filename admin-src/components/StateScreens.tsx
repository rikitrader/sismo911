// Full-screen / inline states for auth + permission + generic errors.
import { Icon } from '../icons';

export function SignInScreen() {
  return (
    <div class="min-h-screen flex items-center justify-center p-6">
      <div class="card p-8 max-w-md w-full text-center animate-scale-in">
        <div class="w-14 h-14 rounded-2xl surface-subtle bordered flex items-center justify-center mx-auto mb-5 text-faint">
          <Icon.lock size={26} />
        </div>
        <h1 class="text-lg font-semibold">Inicia sesión como administrador</h1>
        <p class="text-muted text-[13.5px] mt-2 leading-relaxed">
          Necesitas una sesión de administrador para acceder a la consola.
        </p>
        <a class="btn btn-primary w-full mt-6" href="/login?next=/console/">
          Ir a iniciar sesión
        </a>
      </div>
    </div>
  );
}

export function ForbiddenInline({ message }: { message?: string }) {
  return (
    <div class="card p-8 text-center animate-fade-in">
      <div class="w-12 h-12 rounded-xl surface-subtle bordered flex items-center justify-center mx-auto mb-4 text-warn">
        <Icon.alert size={22} />
      </div>
      <p class="font-medium text-[15px]">No tienes permiso</p>
      <p class="text-muted text-[13px] mt-1.5 max-w-sm mx-auto">
        {message || 'Tu cuenta no tiene los permisos necesarios para ver esta sección.'}
      </p>
    </div>
  );
}

export function ErrorInline({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div class="card p-8 text-center animate-fade-in">
      <div class="w-12 h-12 rounded-xl surface-subtle bordered flex items-center justify-center mx-auto mb-4 text-danger">
        <Icon.alert size={22} />
      </div>
      <p class="font-medium text-[15px]">Algo salió mal</p>
      <p class="text-muted text-[13px] mt-1.5 max-w-sm mx-auto break-words">{message || 'No se pudieron cargar los datos.'}</p>
      {onRetry && <button class="btn btn-outline mt-5" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}
