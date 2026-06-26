import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { Field } from '@/components/Field';
import { PrimaryButton } from '@/components/PrimaryButton';
import { colors, spacing } from '@/constants/theme';
import { API_BASE_URL, healthCheck, listMissingPersons, submitMissingPerson } from '@/api/client';
import type { MissingPerson, MissingPersonInput } from '@/types/api';

type FormState = {
  full_name: string;
  age: string;
  sex: string;
  last_seen: string;
  contact_phone: string;
  reported_by: string;
  notes: string;
  last_seen_lat: number | null;
  last_seen_lon: number | null;
};

const emptyForm: FormState = {
  full_name: '',
  age: '',
  sex: '',
  last_seen: '',
  contact_phone: '',
  reported_by: '',
  notes: '',
  last_seen_lat: null,
  last_seen_lon: null,
};

export default function MissingPersonReportScreen() {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [persons, setPersons] = useState<MissingPerson[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [locating, setLocating] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  const canSubmit = useMemo(() => form.full_name.trim().length > 1, [form.full_name]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const load = useCallback(async () => {
    const [health, registry] = await Promise.all([healthCheck(), listMissingPersons()]);
    setApiOnline(Boolean(health.ok));
    setPersons(registry.persons);
  }, []);

  useEffect(() => {
    load().catch(() => setApiOnline(false));
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } catch (error) {
      Alert.alert('No se pudo actualizar', error instanceof Error ? error.message : 'Error de conexion');
    } finally {
      setRefreshing(false);
    }
  };

  const useCurrentLocation = async () => {
    setLocating(true);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Permiso de ubicacion', 'Activa la ubicacion para agregar coordenadas al reporte.');
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      update('last_seen_lat', pos.coords.latitude);
      update('last_seen_lon', pos.coords.longitude);
    } catch (error) {
      Alert.alert('Ubicacion no disponible', error instanceof Error ? error.message : 'Intenta de nuevo.');
    } finally {
      setLocating(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) {
      Alert.alert('Falta informacion', 'El nombre de la persona desaparecida es requerido.');
      return;
    }
    setLoading(true);
    try {
      const age = Number.parseInt(form.age.trim(), 10);
      const payload: MissingPersonInput = {
        full_name: form.full_name.trim(),
        age: Number.isFinite(age) ? age : null,
        sex: form.sex.trim() || null,
        last_seen: form.last_seen.trim() || null,
        contact_phone: form.contact_phone.trim() || null,
        reported_by: form.reported_by.trim() || null,
        notes: form.notes.trim() || null,
        last_seen_lat: form.last_seen_lat,
        last_seen_lon: form.last_seen_lon,
      };
      const response = await submitMissingPerson(payload);
      setForm(emptyForm);
      await refresh();
      Alert.alert('Reporte recibido', `${response.message}\nCaso: ${response.id}`);
    } catch (error) {
      Alert.alert('No se pudo enviar', error instanceof Error ? error.message : 'Error de conexion');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        contentContainerStyle={styles.content}
      >
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: apiOnline ? colors.green : colors.amber }]} />
          <Text style={styles.statusText}>
            {apiOnline ? 'Conectado a sismo911.com' : 'Verificando conexion'} · {API_BASE_URL}
          </Text>
        </View>

        <View style={styles.hero}>
          <Text style={styles.kicker}>Registro de personas desaparecidas</Text>
          <Text style={styles.title}>Reportar persona desaparecida</Text>
          <Text style={styles.subtitle}>
            El reporte se guarda en la base de datos de SISMO911 y queda pendiente de revision antes de publicarse.
          </Text>
        </View>

        <View style={styles.form}>
          <Field
            label="Nombre completo"
            autoCapitalize="words"
            value={form.full_name}
            onChangeText={(v) => update('full_name', v)}
            placeholder="Ej. Maria Fernanda Perez"
          />
          <View style={styles.twoCols}>
            <Field
              label="Edad"
              keyboardType="number-pad"
              value={form.age}
              onChangeText={(v) => update('age', v)}
              placeholder="35"
              style={styles.compactInput}
            />
            <Field
              label="Sexo"
              value={form.sex}
              onChangeText={(v) => update('sex', v)}
              placeholder="F / M / Otro"
              style={styles.compactInput}
            />
          </View>
          <Field
            label="Ultimo lugar visto"
            value={form.last_seen}
            onChangeText={(v) => update('last_seen', v)}
            placeholder="Ciudad, sector, refugio, edificio o referencia"
            multiline
          />
          <Pressable style={styles.locationButton} onPress={useCurrentLocation} disabled={locating}>
            <Ionicons name="location-outline" size={20} color={colors.dangerDark} />
            <Text style={styles.locationText}>
              {form.last_seen_lat && form.last_seen_lon
                ? `Ubicacion agregada (${form.last_seen_lat.toFixed(3)}, ${form.last_seen_lon.toFixed(3)})`
                : locating ? 'Buscando ubicacion...' : 'Usar mi ubicacion actual como referencia'}
            </Text>
          </Pressable>
          <Field
            label="Telefono de contacto"
            keyboardType="phone-pad"
            value={form.contact_phone}
            onChangeText={(v) => update('contact_phone', v)}
            placeholder="+58..."
          />
          <Field
            label="Reportado por"
            value={form.reported_by}
            onChangeText={(v) => update('reported_by', v)}
            placeholder="Tu nombre o institucion"
          />
          <Field
            label="Detalles adicionales"
            value={form.notes}
            onChangeText={(v) => update('notes', v)}
            placeholder="Ropa, condicion medica, familiares, informacion de contacto adicional"
            multiline
          />
          <PrimaryButton title="Enviar reporte" onPress={submit} loading={loading} disabled={!canSubmit} />
        </View>

        <View style={styles.registryHeader}>
          <Text style={styles.sectionTitle}>Personas aprobadas en busqueda</Text>
          <Text style={styles.count}>{persons.length}</Text>
        </View>

        <FlatList
          scrollEnabled={false}
          data={persons.slice(0, 20)}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<Text style={styles.empty}>No hay registros aprobados para mostrar.</Text>}
          renderItem={({ item }) => (
            <View style={styles.personRow}>
              <View style={styles.avatar}>
                <Ionicons name="person-outline" size={20} color={colors.dangerDark} />
              </View>
              <View style={styles.personBody}>
                <Text style={styles.personName}>{item.full_name}</Text>
                <Text style={styles.personMeta}>
                  {[item.age ? `${item.age} anos` : null, item.last_seen].filter(Boolean).join(' · ') || 'Sin detalles publicos'}
                </Text>
              </View>
            </View>
          )}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  statusRow: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 999,
  },
  statusText: {
    flex: 1,
    color: colors.muted,
    fontSize: 12,
  },
  hero: {
    gap: spacing.sm,
  },
  kicker: {
    color: colors.dangerDark,
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  title: {
    color: colors.ink,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '900',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
  },
  form: {
    gap: spacing.md,
  },
  twoCols: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  compactInput: {
    minWidth: 0,
  },
  locationButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    backgroundColor: '#fff7f7',
    paddingHorizontal: spacing.md,
  },
  locationText: {
    flex: 1,
    color: colors.dangerDark,
    fontWeight: '700',
  },
  registryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '900',
  },
  count: {
    minWidth: 34,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: '#fee2e2',
    color: colors.dangerDark,
    textAlign: 'center',
    paddingVertical: 6,
    fontWeight: '900',
  },
  separator: {
    height: 10,
  },
  empty: {
    color: colors.muted,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fee2e2',
  },
  personBody: {
    flex: 1,
    gap: 3,
  },
  personName: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  personMeta: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
});
