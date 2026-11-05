<template>
  <div class="lab-page">
    <PageHead
      title="账号管理"
      note="管理员维护普通用户；短信认证开启后，普通用户登录需要手机验证码。管理员账号只由启动配置产生，界面不提供新建与提权。"
    >
      <template #ops>
        <el-button size="small" @click="refreshKey += 1">重新读取</el-button>
      </template>
    </PageHead>
    <AccountsPane :key="refreshKey" />
  </div>
</template>

<script setup>
/**
 * 账号管理外壳（路由 #/accounts）：只给管理员。本页不做数据处理，拉取与写操作都在 AccountsPane。
 * 用 key 递增强制重挂：AccountsPane 只在 onMounted 拉一次，重新读取按钮要能真的重发请求。
 */
import { ref } from 'vue';
import PageHead from '../ui/PageHead.vue';
import AccountsPane from './platform/AccountsPane.vue';

defineProps({ gate: { type: Object, default: null } });

const refreshKey = ref(0);
</script>
