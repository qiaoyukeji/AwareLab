<template>
  <section class="lab-pane" :class="{ 'lab-pane--flush': flush }">
    <header v-if="title || $slots.ops" class="lab-pane-hd">
      <div>
        <span class="lab-pane-t">{{ title }}</span>
        <span v-if="hint" class="lab-hint" style="margin-left: 10px">{{ hint }}</span>
      </div>
      <div class="lab-pane-ops"><slot name="ops" /></div>
    </header>
    <div class="lab-pane-bd"><slot /></div>
    <footer v-if="$slots.ft" class="lab-pane-ft"><slot name="ft" /></footer>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  hint: { type: String, default: '' },
  flush: { type: Boolean, default: false },
});
</script>
