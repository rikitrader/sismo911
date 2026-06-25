---
name: Seismic Command
colors:
  surface: '#f9f9fc'
  surface-dim: '#dadadc'
  surface-bright: '#f9f9fc'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f3f6'
  surface-container: '#eeeef0'
  surface-container-high: '#e8e8ea'
  surface-container-highest: '#e2e2e5'
  on-surface: '#1a1c1e'
  on-surface-variant: '#44474f'
  inverse-surface: '#2f3133'
  inverse-on-surface: '#f0f0f3'
  outline: '#747780'
  outline-variant: '#c4c6d0'
  surface-tint: '#445e91'
  primary: '#00173a'
  on-primary: '#ffffff'
  primary-container: '#0b2b5b'
  on-primary-container: '#7a94ca'
  inverse-primary: '#adc6ff'
  secondary: '#bb0027'
  on-secondary: '#ffffff'
  secondary-container: '#e0283c'
  on-secondary-container: '#fffbff'
  tertiary: '#14191b'
  on-tertiary: '#ffffff'
  tertiary-container: '#292d2f'
  on-tertiary-container: '#909497'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a41'
  on-primary-fixed-variant: '#2b4677'
  secondary-fixed: '#ffdad8'
  secondary-fixed-dim: '#ffb3b1'
  on-secondary-fixed: '#410007'
  on-secondary-fixed-variant: '#92001c'
  tertiary-fixed: '#e0e3e6'
  tertiary-fixed-dim: '#c3c7ca'
  on-tertiary-fixed: '#181c1e'
  on-tertiary-fixed-variant: '#43474a'
  background: '#f9f9fc'
  on-background: '#1a1c1e'
  surface-variant: '#e2e2e5'
typography:
  display-lg:
    fontFamily: Public Sans
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Public Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  headline-sm:
    fontFamily: Public Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  label-caps:
    fontFamily: Public Sans
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  gutter: 16px
  margin-mobile: 16px
  margin-desktop: 32px
  container-max: 1440px
---

## Brand & Style

The design system is engineered for **SISMO911**, an earthquake tracking dashboard that prioritizes authority, rapid information retrieval, and institutional trust. The brand personality is serious, vigilant, and mission-critical, mirroring the visual language of government emergency agencies like FEMA or USGS.

The aesthetic follows a **Corporate / Modern** direction with a heavy emphasis on **High-Contrast** functionalism. It utilizes a rigid grid, clear information hierarchy, and a color-coded alert system to ensure that data remains legible under high-stress, real-time monitoring conditions. The goal is to evoke an emotional response of security and precision.

## Colors

The palette is derived directly from the institutional seal to reinforce governmental authority. 

- **Primary (Navy Blue):** Used for headers, navigation, and structural "grounding" elements. It represents stability and official status.
- **Secondary (Emergency Red):** Reserved strictly for critical alerts, high-magnitude seismic events, and urgent "Action Required" states.
- **Tertiary (Cool Slate):** A neutral background wash that reduces eye strain during long monitoring shifts compared to pure white.
- **Neutral (Carbon):** Used for high-legibility body text and data points.

**Alert Scale:**
- **Critical:** #C8102E (Red)
- **Warning:** #E57200 (Orange)
- **Advisory:** #FFBC3D (Yellow)
- **Safe/Normal:** #2E7D32 (Green)

## Typography

This design system utilizes a tiered typography strategy to separate narrative information from technical data.

- **Public Sans** is the primary typeface for headings and interface labels. Its institutional, neutral character ensures the UI feels like an official utility.
- **Inter** is used for body copy and descriptions, chosen for its exceptional legibility on digital screens.
- **JetBrains Mono** is reserved for seismic magnitude values, coordinates (lat/long), and timestamps. The monospaced nature prevents "jumping" layouts during real-time data refreshes.

**Scaling:** On mobile devices, `display-lg` should scale down to `32px` to maintain screen real estate for maps and charts.

## Layout & Spacing

The layout uses a **Fixed Grid** model on desktop to ensure that critical dashboard widgets remain in predictable locations for power users. 

- **Desktop:** 12-column grid with a 1440px max-width. 32px external margins and 16px gutters.
- **Tablet:** 8-column grid.
- **Mobile:** 4-column grid with a single-column reflow for data lists.

The spacing rhythm follows a strict 4px base unit. Information density is kept "Medium-High" to allow for a comprehensive overview of multiple seismic sensors without excessive scrolling. Use whitespace strategically to group related data points (e.g., Magnitude, Depth, and Location) into distinct visual clusters.

## Elevation & Depth

The design system employs **Tonal Layers** and **Low-Contrast Outlines** rather than heavy shadows to maintain a flat, professional, and digital-first appearance.

- **Level 0 (Background):** Tertiary color (#F4F7FA).
- **Level 1 (Cards/Panels):** Pure White (#FFFFFF) with a 1px solid border (#D1D5DB).
- **Level 2 (Active/Floating):** Use a subtle ambient shadow (0px 4px 12px rgba(11, 43, 91, 0.08)) to indicate modals or active dropdowns.

Depth is used primarily to signify "Importance" rather than "Physicality." A critical alert card may use a thick 4px left-border in Emergency Red to immediately draw the eye without needing 3D effects.

## Shapes

The shape language is **Soft (0.25rem)**. This slight rounding provides a modern touch while maintaining the rigid, structured feel of a professional tool. 

- **Standard Buttons & Inputs:** 4px radius.
- **Dashboard Widgets:** 8px radius (`rounded-lg`).
- **Status Pills:** Fully rounded (pill-shaped) to distinguish them from interactive buttons.

Avoid organic or overly rounded shapes to ensure the UI feels precise and calculated.

## Components

### Buttons
- **Primary:** Navy blue fill with white text. High contrast, bold weight.
- **Secondary:** Transparent with a navy blue border.
- **Critical:** Emergency Red fill. Used only for "Delete," "Stop," or "Emergency Alert" functions.

### Data Chips
- Used for magnitude levels (e.g., "M 4.5"). The background color of the chip must change based on the magnitude intensity (Green -> Yellow -> Red).

### Lists
- High-density rows with 1px dividers. Each row should feature a "Magnitude Badge" on the left and a "Time Relative" stamp on the right.

### Input Fields
- Structured with clear top-aligned labels. Use a focus state that utilizes a 2px navy blue border to ensure the user knows exactly where they are typing.

### Cards
- Dashboard widgets must have a defined header area with a light grey background (#F9FAFB) to separate the title from the data visualization below.

### Seismic Map Markers
- Circular markers with concentric rings. The size of the marker correlates to magnitude, while the pulse animation intensity correlates to how recently the event occurred.