<template>
  <div class="lab-page">
    <!-- 三项（主体/有效期/域名名单）齐了才解锁，缺一项其他工作区全部拒绝投放 -->
    <PageHead title="演练授权" note="平台能不能干活全看这里：授权主体、有效期、允许仿冒的域名三项齐备才解锁，吊销即全部停下。" />
    <MandatePane :gate="gate" />
  </div>
</template>

<script setup>
/** 演练授权工作区外壳（路由 #/mandate）：CRUD 全在 mandate/MandatePane.vue（/authorizations*）。
 *  gate 由 AppShell 每 30 秒轮询 /authorizations，登记完最多滞后一个周期红条才消失；放行判定在服务端。 */
import PageHead from '../ui/PageHead.vue';
import MandatePane from './mandate/MandatePane.vue';

// 外壳不读 gate 字段，仍声明以承接父级透传
defineProps({ gate: { type: Object, default: null } });
</script>
