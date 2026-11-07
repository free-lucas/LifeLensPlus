Phase 5.1：Job Recovery / 补偿机制

启动的时候检查：

所有 analysisStatus = PENDING 的 Activity

然后检查：

有没有对应的 AI Job？

没有：

创建 Job

有：

跳过

于是：

Activity PENDING
        ↓
启动恢复扫描
        ↓
有没有 AI Job？
    ↙       ↘
   有        没有
   ↓          ↓
跳过       创建Job
              ↓
             Queue
              ↓
             AI