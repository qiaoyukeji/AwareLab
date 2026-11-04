<template>
  <header class="lab-page-hd">
    <div>
      <h2 class="lab-page-title">{{ title }}</h2>
      <p class="lab-page-note">{{ note }}</p>
    </div>
    <div class="lab-page-ops"><slot name="ops" /></div>
  </header>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  note: { type: String, default: '' },
});
</script>
